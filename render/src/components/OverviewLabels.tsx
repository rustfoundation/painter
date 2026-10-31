import { useEffect, useMemo, useRef, type RefObject } from 'react';
import type NVL from '@neo4j-nvl/base';
import './OverviewLabels.css';

/** One label under a node: a title line and an optional smaller second line. */
export interface LabelSpec {
  id: string;
  text: string;
  sub?: string;
  sub2?: string;
  /** CSS modifier: root, dep, dependent, callee, version, account, other. */
  cls: string;
  /** Node radius in layout units (NVL `size`), to hang the label under the circle. */
  size: number;
}

interface Props {
  nvlRef: RefObject<NVL | null>;
  specs: LabelSpec[];
  active: boolean;
}

// Screen radius below which a label is dropped, and the zoom below which the detail lines go (so a fitted
// dense fan shows names only and zooming in reveals the rest everywhere at once).
const MIN_RADIUS_PX = 4;
const MIN_SUB_SCALE = 0.7;

/**
 * NVL's canvas renderer fits captions inside the circle and hides them once the node is small on screen,
 * so most nodes of a fitted overview are anonymous. This draws the captions as DOM text under each node
 * instead, following the canvas every animation frame via `getNodes()` client positions. The overlay does
 * not take pointer events, so clicks, drags and wheel still reach NVL.
 */
export function OverviewLabels({ nvlRef, specs, active }: Props) {
  const els = useRef(new Map<string, HTMLDivElement>());
  const container = useRef<HTMLDivElement>(null);
  const sizes = useMemo(() => new Map(specs.map((s) => [s.id, s.size])), [specs]);

  useEffect(() => {
    if (!active) return undefined;
    let raf = 0;
    const tick = () => {
      const nvl = nvlRef.current;
      if (nvl) {
        let scale = 1;
        let nodes: ReturnType<NVL['getNodes']> = [];
        try {
          scale = nvl.getScale();
          nodes = nvl.getNodes();
        } catch {
          nodes = [];
        }
        container.current?.classList.toggle('no-sub', scale < MIN_SUB_SCALE);
        const seen = new Set<string>();
        for (const n of nodes) {
          const el = els.current.get(n.id);
          if (!el || !n.clientPosition) continue;
          seen.add(n.id);
          const r = (sizes.get(n.id) ?? n.size ?? 10) * scale;
          if (r < MIN_RADIUS_PX) {
            el.style.display = 'none';
            continue;
          }
          el.style.display = '';
          el.style.left = `${n.clientPosition.x}px`;
          el.style.top = `${n.clientPosition.y + r + 2}px`;
        }
        for (const [id, el] of els.current) if (!seen.has(id)) el.style.display = 'none';
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [active, nvlRef, sizes]);

  if (!active) return null;
  return (
    <div className="node-labels" aria-hidden ref={container}>
      {specs.map((s) => (
        <div
          key={s.id}
          className={`node-label ${s.cls}`}
          style={{ display: 'none' }}
          ref={(el) => {
            if (el) els.current.set(s.id, el);
            else els.current.delete(s.id);
          }}
        >
          <span className="t">{s.text}</span>
          {s.sub ? <span className="s">{s.sub}</span> : null}
          {s.sub2 ? <span className="s">{s.sub2}</span> : null}
        </div>
      ))}
    </div>
  );
}
