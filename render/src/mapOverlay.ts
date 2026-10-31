// Canvas2D drawing for the Map view's overlay: everything NVL cannot draw well at this scale.
// Density cells show where the unlabelled crates are, community blobs carry the names of their
// dominant crates, and the selection gets a halo. Coordinates arrive as layout units and are
// mapped to screen px by the caller's calibration (see MapView.calibrate).

import type { LodCommunity, LodViewport } from './api';

/** Sixteen hues that read on the dark background; communities beyond the top 16 are grey. */
export const MAP_PALETTE = [
  '#4C8DFF',
  '#F5A623',
  '#2BB673',
  '#E5484D',
  '#B88BFF',
  '#20B2AA',
  '#E36BAE',
  '#C9A227',
  '#7FB3FF',
  '#FF8C42',
  '#8BD17C',
  '#FF6B9D',
  '#9D8DF1',
  '#5CC8D7',
  '#D4A373',
  '#A3B18A',
];
export const MAP_GREY = '#5b6472';
/** Only this many communities (by downloads) get a blob and a label; beyond that they are small or noise. */
const LABELLED_COMMUNITIES = 24;

export const makeColorOf = (communities: LodCommunity[] | null) => {
  const slot = new Map<number, number>();
  (communities ?? []).slice(0, MAP_PALETTE.length).forEach((c, i) => slot.set(c.id, i));
  return (community: number) => {
    const i = slot.get(community);
    return i === undefined ? MAP_GREY : MAP_PALETTE[i];
  };
};

const hexAlpha = (hex: string, alpha: number) => {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
};

export interface OverlayScene {
  width: number;
  height: number;
  /** Layout -> screen px. */
  toScreen: (x: number, y: number) => { sx: number; sy: number };
  /** Screen px per layout unit. */
  pxPerUnit: number;
  density: LodViewport['density'] | null;
  communities: LodCommunity[] | null;
  colorOf: (community: number) => string;
  selected: { x: number; y: number } | null;
  /** Edges in layout space; drawn under the dots as thin screen-space lines (NVL widths scale with zoom between fetches). */
  edges: { x1: number; y1: number; x2: number; y2: number; color: string; width: number }[];
  /** Landmark labels in priority order (most important first); drawn where they do not collide. */
  labels: { x: number; y: number; text: string; weight: number; selected?: boolean }[];
  /** performance.now() when the selection was made, for the locate pulse. */
  pulseAt: number | null;
  now: number;
  /** Community ids whose label should be suppressed (e.g. the selected crate's own, shown in the panel). */
  hideLabels?: boolean;
}

const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

const rgbOf = (hex: string): [number, number, number] => [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];

/** Reused low-resolution image: one pixel per density cell, scaled up with bilinear smoothing so it reads as a soft heat map. */
let heat: HTMLCanvasElement | null = null;
/** The heat image only changes with the payload, the palette, or the fade; remember what it was built for. */
let heatKey: { density: LodViewport['density']; colorOf: OverlayScene['colorOf']; fade: number; big: boolean } | null = null;

const drawDensity = (ctx: CanvasRenderingContext2D, s: OverlayScene) => {
  const d = s.density;
  if (!d || d.cells.length === 0) return;
  const cw = (d.x1 - d.x0) / d.cols;
  const ch = (d.y1 - d.y0) / d.rows;
  const o = s.toScreen(d.x0, d.y0);
  const sw = cw * s.pxPerUnit;
  const sh = ch * s.pxPerUnit;
  // Cells larger than ~60 px on screen are a blur of nothing rather than a density cue: fade them out.
  const big = Math.max(sw, sh);
  const fade = big <= 60 ? 1 : Math.max(0, (130 - big) / 70);
  if (fade <= 0) return;
  if (!heat) heat = document.createElement('canvas');
  const fadeQ = Math.round(fade * 20) / 20;
  const fresh = heatKey && heatKey.density === d && heatKey.colorOf === s.colorOf && heatKey.fade === fadeQ && heatKey.big === big > 10;
  if (!fresh) buildHeat(heat, d, s.colorOf, fadeQ, big > 10);
  heatKey = { density: d, colorOf: s.colorOf, fade: fadeQ, big: big > 10 };
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(heat, o.sx, o.sy, d.cols * sw, d.rows * sh);
};

const buildHeat = (heat: HTMLCanvasElement, d: NonNullable<LodViewport['density']>, colorOf: OverlayScene['colorOf'], fade: number, big: boolean) => {
  let max = 1;
  for (let k = 1; k < d.cells.length; k += 3) if (d.cells[k] > max) max = d.cells[k];
  const lmax = Math.log(max + 1);
  if (heat.width !== d.cols || heat.height !== d.rows) {
    heat.width = d.cols;
    heat.height = d.rows;
  }
  const hctx = heat.getContext('2d');
  if (!hctx) return;
  const img = hctx.createImageData(d.cols, d.rows);
  const rgbCache = new Map<number, [number, number, number]>();
  for (let k = 0; k < d.cells.length; k += 3) {
    const idx = d.cells[k];
    const count = d.cells[k + 1];
    // A lone crate in a large cell is already drawn as a dot; shading it only adds a square shadow.
    if (count <= 1 && big) continue;
    const comm = d.cells[k + 2];
    let rgb = rgbCache.get(comm);
    if (!rgb) {
      rgb = rgbOf(colorOf(comm));
      rgbCache.set(comm, rgb);
    }
    const alpha = (0.06 + 0.4 * (Math.log(count + 1) / lmax) ** 1.3) * fade;
    const p = idx * 4;
    img.data[p] = rgb[0];
    img.data[p + 1] = rgb[1];
    img.data[p + 2] = rgb[2];
    img.data[p + 3] = Math.round(Math.min(1, alpha) * 255);
  }
  hctx.putImageData(img, 0, 0);
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const drawCommunities = (ctx: CanvasRenderingContext2D, s: OverlayScene, placed: Rect[]) => {
  if (!s.communities) return;
  const diag = Math.hypot(s.width, s.height);
  ctx.lineJoin = 'round';
  for (const c of s.communities.slice(0, LABELLED_COMMUNITIES)) {
    const diam = 2 * c.radius * s.pxPerUnit;
    // Too small to mean anything, or so large that we are inside it (a hull drawn from inside is a stray polygon edge).
    if (diam < 56 || diam > diag * 1.6) continue;
    const centre = s.toScreen(c.x, c.y);
    if (centre.sx < -diam || centre.sy < -diam || centre.sx > s.width + diam || centre.sy > s.height + diam) continue;
    const color = s.colorOf(c.id);
    if (c.hull.length >= 3 && diam <= diag) {
      ctx.beginPath();
      c.hull.forEach(([hx, hy], i) => {
        const p = s.toScreen(hx, hy);
        if (i === 0) ctx.moveTo(p.sx, p.sy);
        else ctx.lineTo(p.sx, p.sy);
      });
      ctx.closePath();
      ctx.fillStyle = hexAlpha(color, 0.06);
      ctx.fill();
      ctx.strokeStyle = hexAlpha(color, 0.3);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (s.hideLabels) continue;
    const size = Math.max(11, Math.min(19, 10 + Math.log2(c.size + 1) * 0.8));
    ctx.font = `600 ${size}px ${FONT}`;
    const text = c.top.slice(0, 3).join(' · ');
    const tw = ctx.measureText(text).width;
    const rect: Rect = { x: centre.sx - tw / 2 - 6, y: centre.sy - size, w: tw + 12, h: size * 1.6 };
    if (rect.w > Math.max(diam * 1.6, 160)) continue;
    if (placed.some((r) => overlaps(r, rect))) continue;
    placed.push(rect);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(10, 12, 18, 0.85)';
    ctx.strokeText(text, centre.sx, centre.sy);
    ctx.fillStyle = hexAlpha(color, 0.95);
    ctx.fillText(text, centre.sx, centre.sy);
  }
};

const drawSelection = (ctx: CanvasRenderingContext2D, s: OverlayScene) => {
  if (!s.selected) return;
  const p = s.toScreen(s.selected.x, s.selected.y);
  ctx.beginPath();
  ctx.arc(p.sx, p.sy, 22, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(p.sx, p.sy, 34, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();
  if (s.pulseAt !== null) {
    const t = (s.now - s.pulseAt) / 1400;
    if (t >= 0 && t < 1) {
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, 24 + t * 90, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.8})`;
      ctx.lineWidth = 3 * (1 - t) + 0.5;
      ctx.stroke();
    }
  }
};

const drawEdges = (ctx: CanvasRenderingContext2D, s: OverlayScene) => {
  ctx.lineCap = 'round';
  for (const e of s.edges) {
    const a = s.toScreen(e.x1, e.y1);
    const b = s.toScreen(e.x2, e.y2);
    if (Math.max(a.sx, b.sx) < 0 || Math.max(a.sy, b.sy) < 0 || Math.min(a.sx, b.sx) > s.width || Math.min(a.sy, b.sy) > s.height) continue;
    ctx.beginPath();
    ctx.moveTo(a.sx, a.sy);
    ctx.lineTo(b.sx, b.sy);
    ctx.strokeStyle = e.color;
    ctx.lineWidth = e.width;
    ctx.stroke();
  }
};

/** Crate names next to their dots, most important first, skipping any that would overlap a label already placed. */
const drawLabels = (ctx: CanvasRenderingContext2D, s: OverlayScene, placed: Rect[]) => {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const l of s.labels) {
    const p = s.toScreen(l.x, l.y);
    if (p.sx < -200 || p.sy < -20 || p.sx > s.width + 20 || p.sy > s.height + 20) continue;
    const size = l.selected ? 14 : Math.max(10.5, Math.min(13.5, 9.5 + l.weight * 0.25));
    ctx.font = `${l.selected || l.weight > 12 ? 600 : 500} ${size}px ${FONT}`;
    const tw = ctx.measureText(l.text).width;
    const dx = 7 + (l.weight > 12 ? 4 : 0);
    const rect: Rect = { x: p.sx + dx - 2, y: p.sy - size * 0.7, w: tw + 4, h: size * 1.4 };
    if (!l.selected && placed.some((r) => overlaps(r, rect))) continue;
    placed.push(rect);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(10, 12, 18, 0.9)';
    ctx.strokeText(l.text, p.sx + dx, p.sy);
    ctx.fillStyle = l.selected ? '#ffffff' : l.weight > 12 ? '#f1f4f8' : 'rgba(225, 230, 238, 0.85)';
    ctx.fillText(l.text, p.sx + dx, p.sy);
  }
};

export const drawOverlay = (ctx: CanvasRenderingContext2D, s: OverlayScene) => {
  ctx.clearRect(0, 0, s.width, s.height);
  drawDensity(ctx, s);
  const placed: Rect[] = [];
  drawCommunities(ctx, s, placed);
  drawEdges(ctx, s);
  drawLabels(ctx, s, placed);
  drawSelection(ctx, s);
};

/** True while a locate pulse still needs animation frames. */
export const pulseActive = (pulseAt: number | null, now: number) => pulseAt !== null && now - pulseAt < 1400;
