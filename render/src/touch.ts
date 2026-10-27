import { useEffect, useState, type RefObject } from 'react';
import type NVL from '@neo4j-nvl/base';

/** Keep in sync with the `@media (max-width: …)` breakpoint in styles.css. */
export const MOBILE_QUERY = '(max-width: 768px)';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export const useIsMobile = () => useMediaQuery(MOBILE_QUERY);

interface Gesture {
  zoom: number;
  pan: { x: number; y: number };
  mid: { x: number; y: number };
  dist: number;
  fingers: number;
}

/**
 * One-finger pan and two-finger pinch zoom for an NVL canvas. NVL's own
 * interaction handlers only listen to mouse and wheel events, so touchscreens
 * could neither pan nor zoom. The container needs `touch-action: none` so the
 * browser does not scroll or zoom the page instead; taps still produce the
 * compatibility mouse events NVL uses for clicks. Takes the element rather than a
 * ref because the graph canvas mounts and unmounts as views switch.
 */
export function useTouchZoomPan(el: HTMLElement | null, nvlRef: RefObject<NVL | null>) {
  useEffect(() => {
    if (!el) return;
    let start: Gesture | null = null;

    const points = (e: TouchEvent) => {
      const t = Array.from(e.touches).slice(0, 2);
      const mid = { x: t.reduce((s, p) => s + p.clientX, 0) / t.length, y: t.reduce((s, p) => s + p.clientY, 0) / t.length };
      const dist = t.length === 2 ? Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) : 0;
      return { mid, dist, fingers: t.length };
    };

    // Restart from the current state whenever the finger count changes, so lifting one
    // finger of a pinch continues as a pan without a jump.
    const begin = (e: TouchEvent) => {
      const nvl = nvlRef.current;
      if (!nvl || e.touches.length === 0) {
        start = null;
        return;
      }
      start = { zoom: nvl.getScale(), pan: nvl.getPan(), ...points(e) };
    };

    const move = (e: TouchEvent) => {
      const nvl = nvlRef.current;
      if (!nvl || !start || e.touches.length === 0) return;
      const now = points(e);
      if (now.fingers !== start.fingers) {
        begin(e);
        return;
      }
      let zoom = start.zoom;
      if (start.fingers === 2 && start.dist > 0) {
        const { minZoom, maxZoom } = nvl.getZoomLimits();
        zoom = Math.min(maxZoom, Math.max(minZoom, (start.zoom * now.dist) / start.dist));
      }
      // NVL maps a client offset from the canvas centre to layout space as offset * dpr / zoom
      // (see getCanvasCenterOffset in @neo4j-nvl/interaction-handlers). Keep the layout point
      // that was under the starting midpoint under the current one.
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const x = start.pan.x + ((start.mid.x - cx) * dpr) / start.zoom - ((now.mid.x - cx) * dpr) / zoom;
      const y = start.pan.y + ((start.mid.y - cy) * dpr) / start.zoom - ((now.mid.y - cy) * dpr) / zoom;
      nvl.setZoomAndPan(zoom, x, y);
    };

    el.addEventListener('touchstart', begin, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', begin, { passive: true });
    el.addEventListener('touchcancel', begin, { passive: true });
    return () => {
      el.removeEventListener('touchstart', begin);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', begin);
      el.removeEventListener('touchcancel', begin);
    };
  }, [el, nvlRef]);
}
