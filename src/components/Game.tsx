'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  MONSTERS,
  getRandomStartLevel,
  MAX_LEVEL,
  SPECIAL_MERGE_SCORE,
} from '@/lib/monsters';

// ─── Canvas dimensions ─────────────────────────────────────────
const W = 400;
const H = 660;
const WALL = 14;
const FLOOR_Y = H - WALL;
const CEILING_Y = 118;
const DROP_Y = 68;
const GL = WALL;
const GR = W - WALL;
const GW = GR - GL;
const CX = W / 2;
const DROP_COOLDOWN = 550;

// ─── Palette ───────────────────────────────────────────────────
const P = {
  bg:       '#060612',
  gameBg:   '#07071e',
  wallFill: '#0c0c2a',
  wallEdge: '#1e1e60',
  gold:     '#c8a030',
  goldBrt:  '#ffe050',
  goldDrk:  '#7a6018',
  text:     '#f0e0b0',
  textDim:  '#8a7a50',
  danger:   '#ff3030',
  panel:    'rgba(6,6,28,0.92)',
  panelBrd: '#2a1e60',
};

// ─── Types ─────────────────────────────────────────────────────
interface BodyData {
  monsterId: number;
  createdAt: number;
  isMerging: boolean;
}
type Phase = 'start' | 'playing' | 'gameover';
interface GS {
  phase: Phase;
  score: number;
  highScore: number;
  currentLevel: number;
  nextLevel: number;
  dropX: number;
  canDrop: boolean;
  gameOverFrames: number;
  maxLevel: number;       // highest monster level reached this game
}

interface RankEntry { name: string; score: number; maxLevel: number; }

// Floating score / combo popup
interface Popup { x: number; y: number; text: string; start: number; big: boolean; }
const COMBO_WINDOW = 850; // ms within which merges count as a combo
const COMBO_CAP = 9;      // max combo multiplier / display

const RANK_KEY = 'sporinkaRanking';
const RANK_MAX = 10;

function loadRanking(): RankEntry[] {
  try {
    const arr = JSON.parse(localStorage.getItem(RANK_KEY) ?? '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveRanking(r: RankEntry[]) {
  try { localStorage.setItem(RANK_KEY, JSON.stringify(r)); } catch { /* */ }
}
// Insert an entry, sort by score desc, keep top RANK_MAX. Returns
// the new list and the index of the inserted entry (-1 if dropped).
function insertRanking(entry: RankEntry): { list: RankEntry[]; index: number } {
  const list = loadRanking();
  list.push(entry);
  list.sort((a, b) => b.score - a.score);
  const trimmed = list.slice(0, RANK_MAX);
  saveRanking(trimmed);
  const index = trimmed.findIndex((e) => e === entry);
  return { list: trimmed, index };
}

// Display name for an evolution level — the secret monster is masked
function evoName(lvl: number): string {
  return lvl >= MAX_LEVEL ? '？？？' : MONSTERS[lvl].name;
}

// Shared button rects (keep draw + hit-test in sync)
const START_BTN = { w: 184, h: 46, x: CX - 92, y: 300 };
const GO_BTN = { w: 184, h: 44, x: CX - 92, y: 540 };
const GO_SHOT_BTN = { w: 184, h: 40, x: CX - 92, y: 592 };

// ─── Rounded rect path ────────────────────────────────────────
function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── hex → rgba() ─────────────────────────────────────────────
function hexA(hex: string, a: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ─── Processed (background-removed) sprite ────────────────────
interface Vec { x: number; y: number; }
interface Sprite {
  canvas: HTMLCanvasElement;
  bx: number; by: number; bw: number; bh: number; // opaque bounding box
  hull: Vec[];                                     // convex hull (fallback collision)
  outline: Vec[];                                  // concave silhouette outline (sprite px)
  cxh: number; cyh: number;                        // centroid used for render + body alignment
}

// Convex hull (Andrew's monotone chain), returns CCW order
function convexHull(points: Vec[]): Vec[] {
  if (points.length < 3) return points.slice();
  const p = points.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const cross = (o: Vec, a: Vec, b: Vec) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec[] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: Vec[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// Area centroid of a simple polygon
function polyCentroid(v: Vec[]): Vec {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < v.length; i++) {
    const j = (i + 1) % v.length;
    const cr = v[i].x * v[j].y - v[j].x * v[i].y;
    a += cr; cx += (v[i].x + v[j].x) * cr; cy += (v[i].y + v[j].y) * cr;
  }
  if (Math.abs(a) < 1e-6) { // degenerate → mean of vertices
    let mx = 0, my = 0; for (const pt of v) { mx += pt.x; my += pt.y; }
    return { x: mx / v.length, y: my / v.length };
  }
  a *= 0.5;
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

// Reduce a hull to at most `max` vertices by uniform sampling
function simplifyHull(hull: Vec[], max: number): Vec[] {
  if (hull.length <= max) return hull;
  const out: Vec[] = [];
  for (let i = 0; i < max; i++) out.push(hull[Math.floor((i * hull.length) / max)]);
  return out;
}

// Douglas–Peucker polyline simplification (closed contour)
function douglasPeucker(pts: Vec[], eps: number): Vec[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = pts[a], B = pts[b];
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
    let dmax = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const dist = Math.abs((pts[i].x - A.x) * dy - (pts[i].y - A.y) * dx) / len;
      if (dist > dmax) { dmax = dist; idx = i; }
    }
    if (dmax > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx]); stack.push([idx, b]); }
  }
  const out: Vec[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// Trace the concave outline of the largest opaque component (Moore
// boundary tracing) and simplify it to ≤ maxVerts vertices.
function traceOutline(
  d: Uint8ClampedArray, w: number, h: number,
  minx: number, miny: number, maxx: number, maxy: number,
  maxVerts: number,
): Vec[] {
  const EDGE = 80;
  const mask = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) mask[p] = d[p * 4 + 3] > EDGE ? 1 : 0;
  // keep only the largest connected component
  const lbl = new Int32Array(w * h).fill(-1);
  let best = -1, bestA = 0;
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || lbl[s] !== -1) continue;
    const st = [s]; lbl[s] = s; let a = 0;
    while (st.length) {
      const p = st.pop()!; a++;
      const px = p % w, py = (p / w) | 0;
      if (px > 0 && mask[p - 1] && lbl[p - 1] < 0) { lbl[p - 1] = s; st.push(p - 1); }
      if (px < w - 1 && mask[p + 1] && lbl[p + 1] < 0) { lbl[p + 1] = s; st.push(p + 1); }
      if (py > 0 && mask[p - w] && lbl[p - w] < 0) { lbl[p - w] = s; st.push(p - w); }
      if (py < h - 1 && mask[p + w] && lbl[p + w] < 0) { lbl[p + w] = s; st.push(p + w); }
    }
    if (a > bestA) { bestA = a; best = s; }
  }
  if (best < 0) return [];
  for (let p = 0; p < w * h; p++) if (lbl[p] !== best) mask[p] = 0;

  // Moore-neighbor boundary trace
  let sx = -1, sy = -1;
  for (let y = miny; y <= maxy && sx < 0; y++) for (let x = minx; x <= maxx; x++) if (mask[y * w + x]) { sx = x; sy = y; break; }
  if (sx < 0) return [];
  const N = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
  const isF = (x: number, y: number) => x >= 0 && x < w && y >= 0 && y < h && mask[y * w + x] === 1;
  const contour: Vec[] = [];
  let cx = sx, cy = sy, bx = sx - 1, by = sy;
  let count = 0; const maxC = w * h * 8;
  do {
    contour.push({ x: cx + 0.5, y: cy + 0.5 });
    let di = 0; for (; di < 8; di++) if (cx + N[di][0] === bx && cy + N[di][1] === by) break;
    let found = false;
    for (let k = 1; k <= 8; k++) {
      const idx = (di + k) % 8;
      const nx = cx + N[idx][0], ny = cy + N[idx][1];
      if (isF(nx, ny)) {
        const pidx = (idx + 7) % 8;
        bx = cx + N[pidx][0]; by = cy + N[pidx][1];
        cx = nx; cy = ny; found = true; break;
      }
    }
    if (!found) break;
    count++;
  } while (!(cx === sx && cy === sy) && count < maxC);

  if (contour.length < 6) return [];
  // simplify, increasing epsilon until vertex budget is met
  let eps = 2.5;
  let simp = douglasPeucker(contour, eps);
  while (simp.length > maxVerts && eps < 24) { eps += 1.5; simp = douglasPeucker(contour, eps); }
  return simp.length >= 3 ? simp : [];
}

// Remove the light cream background AND the grey ground-shadow by
// flood-filling from the borders inward. A pixel counts as
// background when it is close to the cream colour, OR it is
// low-chroma and bright (the soft grey drop-shadow). The
// character's dark, saturated outline acts as a natural wall, so
// the body and its interior highlights are preserved. The alpha
// channel is then lightly blurred for a soft, feathered edge.
// Keep only the largest opaque connected component (drops detached
// bits such as stray bubbles / specks).
function keepLargestComponent(d: Uint8ClampedArray, w: number, h: number) {
  const lbl = new Int32Array(w * h).fill(-1);
  let best = -1, bestArea = 0;
  for (let s = 0; s < w * h; s++) {
    if (d[s * 4 + 3] < 40 || lbl[s] !== -1) continue;
    const labelId = s; // use the seed index as this component's label
    const stack: number[] = [s];
    lbl[s] = labelId;
    let area = 0;
    while (stack.length) {
      const p = stack.pop()!;
      area++;
      const px = p % w, py = (p / w) | 0;
      if (px > 0 && lbl[p - 1] === -1 && d[(p - 1) * 4 + 3] >= 40) { lbl[p - 1] = labelId; stack.push(p - 1); }
      if (px < w - 1 && lbl[p + 1] === -1 && d[(p + 1) * 4 + 3] >= 40) { lbl[p + 1] = labelId; stack.push(p + 1); }
      if (py > 0 && lbl[p - w] === -1 && d[(p - w) * 4 + 3] >= 40) { lbl[p - w] = labelId; stack.push(p - w); }
      if (py < h - 1 && lbl[p + w] === -1 && d[(p + w) * 4 + 3] >= 40) { lbl[p + w] = labelId; stack.push(p + w); }
    }
    if (area > bestArea) { bestArea = area; best = labelId; }
  }
  for (let p = 0; p < w * h; p++) if (lbl[p] !== best) d[p * 4 + 3] = 0;
}

function eraseCircles(d: Uint8ClampedArray, w: number, h: number, circles: [number, number, number][]) {
  for (const [nx, ny, nr] of circles) {
    const ccx = nx * w, ccy = ny * h, rr = nr * w, rr2 = rr * rr;
    const x0 = Math.max(0, (ccx - rr) | 0), x1 = Math.min(w - 1, (ccx + rr) | 0);
    const y0 = Math.max(0, (ccy - rr) | 0), y1 = Math.min(h - 1, (ccy + rr) | 0);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - ccx, dy = y - ccy;
        if (dx * dx + dy * dy <= rr2) d[(y * w + x) * 4 + 3] = 0;
      }
    }
  }
}

interface SpriteOpts { keepLargest?: boolean; erase?: [number, number, number][]; }

function buildSprite(img: HTMLImageElement, opts: SpriteOpts = {}): Sprite | null {
  const MAXD = 300;
  const ow = img.naturalWidth, oh = img.naturalHeight;
  if (!ow || !oh) return null;
  const sc = Math.min(1, MAXD / Math.max(ow, oh));
  const w = Math.max(1, Math.round(ow * sc));
  const h = Math.max(1, Math.round(oh * sc));

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d', { willReadFrequently: true });
  if (!cx) return null;
  cx.drawImage(img, 0, 0, w, h);

  const id = cx.getImageData(0, 0, w, h);
  const d = id.data;

  // Reference background colour = average of the 4 corners
  let br = 0, bgc = 0, bb = 0, cnt = 0;
  const S = 6;
  const corners = [[0, 0, 1, 1], [w - 1, 0, -1, 1], [0, h - 1, 1, -1], [w - 1, h - 1, -1, -1]];
  for (const [ox, oy, sx, sy] of corners) {
    for (let yy = 0; yy < S; yy++) {
      for (let xx = 0; xx < S; xx++) {
        const px = Math.min(w - 1, Math.max(0, ox + sx * xx));
        const py = Math.min(h - 1, Math.max(0, oy + sy * yy));
        const o = (py * w + px) * 4;
        br += d[o]; bgc += d[o + 1]; bb += d[o + 2]; cnt++;
      }
    }
  }
  br /= cnt; bgc /= cnt; bb /= cnt;

  // Background predicate: cream-close OR (low-chroma AND bright)
  const CREAM2 = 54 * 54;  // cream colour tolerance²
  const CHROMA = 32;       // max channel spread to count as "grey"
  const BRIGHT = 168;      // min brightness for grey shadow / cream
  const isBg = (o: number): boolean => {
    if (d[o + 3] < 16) return true; // already transparent (pre-cut PNG)
    const r = d[o], g = d[o + 1], b = d[o + 2];
    const dr = r - br, dg = g - bgc, db = b - bb;
    if (dr * dr + dg * dg + db * db <= CREAM2) return true;
    const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
    return mx - mn <= CHROMA && mx >= BRIGHT;
  };

  const visited = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) { stack.push(x); stack.push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + w - 1); }

  while (stack.length) {
    const p = stack.pop()!;
    if (visited[p]) continue;
    visited[p] = 1;
    const o = p * 4;
    if (isBg(o)) {
      d[o + 3] = 0;
      const px = p % w, py = (p / w) | 0;
      if (px > 0 && !visited[p - 1]) stack.push(p - 1);
      if (px < w - 1 && !visited[p + 1]) stack.push(p + 1);
      if (py > 0 && !visited[p - w]) stack.push(p - w);
      if (py < h - 1 && !visited[p + w]) stack.push(p + w);
    }
  }

  // Per-monster cleanup: drop detached bits, erase specific regions
  if (opts.keepLargest) keepLargestComponent(d, w, h);
  if (opts.erase) {
    eraseCircles(d, w, h, opts.erase);
    if (opts.keepLargest) keepLargestComponent(d, w, h);
  }

  // Feather: 3×3 blur of the alpha channel for soft, natural edges
  const a0 = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) a0[p] = d[p * 4 + 3];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += a0[yy * w + xx]; n++;
        }
      }
      d[(y * w + x) * 4 + 3] = (sum / n) | 0;
    }
  }
  cx.putImageData(id, 0, 0);

  // Opaque bounding box
  let minx = w, miny = h, maxx = 0, maxy = 0, any = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 24) {
        any = true;
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
    }
  }
  if (!any) { minx = 0; miny = 0; maxx = w - 1; maxy = h - 1; }

  // Collision silhouette: gather the left/right extreme opaque pixel of
  // each (sampled) row, take the convex hull → a polygon that matches
  // the VISIBLE shape (wings included). Used as the physics body shape.
  const ALPHA_EDGE = 50;
  const pts: Vec[] = [];
  const step = Math.max(1, Math.floor(h / 80));
  for (let y = 0; y <= maxy; y += step) {
    let lx = -1, rx = -1;
    for (let x = minx; x <= maxx; x++) {
      if (d[(y * w + x) * 4 + 3] > ALPHA_EDGE) { if (lx < 0) lx = x; rx = x; }
    }
    if (lx >= 0) { pts.push({ x: lx + 0.5, y: y + 0.5 }); if (rx !== lx) pts.push({ x: rx + 0.5, y: y + 0.5 }); }
  }
  let hull = simplifyHull(convexHull(pts), 16);
  if (hull.length < 3) {
    // fallback: bbox rectangle
    hull = [
      { x: minx, y: miny }, { x: maxx, y: miny },
      { x: maxx, y: maxy }, { x: minx, y: maxy },
    ];
  }

  // Concave outline (follows wings/notches); falls back to the hull
  const outline = traceOutline(d, w, h, minx, miny, maxx, maxy, 28);
  const shape = outline.length >= 3 ? outline : hull;
  const ctr = polyCentroid(shape);

  return {
    canvas: c, bx: minx, by: miny, bw: maxx - minx + 1, bh: maxy - miny + 1,
    hull, outline, cxh: ctr.x, cyh: ctr.y,
  };
}

// ═══════════════════════════════════════════════════════════════
export default function Game() {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const wrapRef       = useRef<HTMLDivElement>(null);
  const engineRef     = useRef<unknown>(null);
  const MRef          = useRef<typeof import('matter-js') | null>(null);
  const bodyDataRef   = useRef<Map<number, BodyData>>(new Map());
  const mergingRef    = useRef<Set<number>>(new Set());
  const rafRef        = useRef<number>(0);
  const scaleRef      = useRef<number>(1);
  const coolRef       = useRef<number>(0);
  const imgsRef       = useRef<Map<number, HTMLImageElement>>(new Map());
  const procRef       = useRef<Map<number, Sprite>>(new Map());
  const secretFxRef   = useRef<{ start: number; sparkles: { x: number; y: number; r: number; tw: number }[] } | null>(null);
  const rankingRef    = useRef<RankEntry[]>([]);
  const lastRankIdxRef = useRef<number>(-1);
  const playerNameRef = useRef<string>('');
  const popupsRef     = useRef<Popup[]>([]);
  const comboRef      = useRef<{ count: number; lastTime: number }>({ count: 0, lastTime: 0 });
  const snapshotRef   = useRef<HTMLCanvasElement | null>(null);

  const gs = useRef<GS>({
    phase: 'start',
    score: 0,
    highScore: 0,
    currentLevel: 0,
    nextLevel: 1,
    dropX: CX,
    canDrop: false,
    gameOverFrames: 0,
    maxLevel: 0,
  });

  const [uiPhase, setUiPhase] = useState<Phase>('start');
  const [playerName, setPlayerName] = useState('');

  // Load saved ranking once on mount
  useEffect(() => { rankingRef.current = loadRanking(); }, []);

  // ── Diamond ornament ────────────────────────────────────────
  const diamond = useCallback((ctx: CanvasRenderingContext2D, x: number, y: number, s: number) => {
    ctx.save();
    ctx.strokeStyle = P.gold;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(x, y - s); ctx.lineTo(x + s, y);
    ctx.lineTo(x, y + s); ctx.lineTo(x - s, y);
    ctx.closePath(); ctx.stroke();
    ctx.restore();
  }, []);

  // ── Draw monster ────────────────────────────────────────────
  const drawMonster = useCallback((
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    level: number,
    alpha = 1,
    angle = 0,
  ) => {
    const m    = MONSTERS[level];
    const r    = m.radius;
    const proc = procRef.current.get(level);

    ctx.save();
    ctx.globalAlpha = alpha;

    if (proc) {
      // ── 透過スプライト描画モード ──────────────────────────
      // 1. モンスターカラーのソフトグロー（回転しない＝対称なので円のまま）
      const halo = ctx.createRadialGradient(x, y, r * 0.52, x, y, r * 1.2);
      halo.addColorStop(0,    hexA(m.glowColor, 0.42));
      halo.addColorStop(0.62, hexA(m.glowColor, 0.16));
      halo.addColorStop(1,    hexA(m.glowColor, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.2, 0, Math.PI * 2);
      ctx.fill();

      // 2. cover スケールでキャラ本体が円を満たすように拡大し、
      //    物理ボディの角度で回転（転がる動き）。中心は当たり判定
      //    ポリゴンの重心に合わせる（物理ボディ位置と一致）
      const s   = (2 * r) / Math.min(proc.bw, proc.bh) * 1.05;
      const dw  = proc.canvas.width  * s;
      const dh  = proc.canvas.height * s;
      const bcx = proc.cxh * s;
      const bcy = proc.cyh * s;
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.drawImage(proc.canvas, -bcx, -bcy, dw, dh);

    } else {
      // ── フォールバック: グラデーション + 漢字 ────────────
      ctx.shadowColor = m.glowColor;
      ctx.shadowBlur  = r * 0.6;

      const g = ctx.createRadialGradient(x - r*0.3, y - r*0.35, r*0.08, x, y, r);
      g.addColorStop(0,    m.highlightColor);
      g.addColorStop(0.55, m.color);
      g.addColorStop(1,    m.shadowColor);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();

      ctx.shadowBlur  = 0;
      ctx.strokeStyle = m.borderColor;
      ctx.lineWidth   = 2;
      ctx.stroke();

      const sp = ctx.createRadialGradient(x-r*0.28, y-r*0.32, 0, x-r*0.28, y-r*0.32, r*0.68);
      sp.addColorStop(0,   'rgba(255,255,255,0.38)');
      sp.addColorStop(0.6, 'rgba(255,255,255,0.06)');
      sp.addColorStop(1,   'rgba(255,255,255,0)');
      ctx.beginPath();
      ctx.arc(x, y, r - 1, 0, Math.PI * 2);
      ctx.fillStyle = sp;
      ctx.fill();

      ctx.shadowColor = m.iconGlow;
      ctx.shadowBlur  = 10;
      ctx.fillStyle   = m.iconColor;
      const fs = Math.max(9, Math.floor(r * 0.58));
      ctx.font = `bold ${fs}px "Noto Serif JP", "Yu Mincho", serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.icon, x, y + 1);
    }

    ctx.restore();
  }, []);

  // ── Background ──────────────────────────────────────────────
  const drawBG = useCallback((ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = P.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = P.gameBg;
    ctx.fillRect(GL, 0, GW, FLOOR_Y);

    ctx.strokeStyle = 'rgba(30,30,90,0.18)';
    ctx.lineWidth = 1;
    for (let x = GL; x <= GR; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, FLOOR_Y); ctx.stroke();
    }
    for (let y = 0; y <= FLOOR_Y; y += 40) {
      ctx.beginPath(); ctx.moveTo(GL, y); ctx.lineTo(GR, y); ctx.stroke();
    }
  }, []);

  // ── Walls ───────────────────────────────────────────────────
  const drawWalls = useCallback((ctx: CanvasRenderingContext2D) => {
    const lg = ctx.createLinearGradient(0, 0, WALL, 0);
    lg.addColorStop(0, '#060618'); lg.addColorStop(1, '#10103a');
    ctx.fillStyle = lg; ctx.fillRect(0, 0, WALL, H);

    const rg = ctx.createLinearGradient(GR, 0, W, 0);
    rg.addColorStop(0, '#10103a'); rg.addColorStop(1, '#060618');
    ctx.fillStyle = rg; ctx.fillRect(GR, 0, WALL, H);

    const fg = ctx.createLinearGradient(0, FLOOR_Y, 0, H);
    fg.addColorStop(0, '#10103a'); fg.addColorStop(1, '#060618');
    ctx.fillStyle = fg; ctx.fillRect(0, FLOOR_Y, W, WALL);

    ctx.strokeStyle = P.wallEdge; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(GL, 0);       ctx.lineTo(GL, FLOOR_Y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(GR, 0);       ctx.lineTo(GR, FLOOR_Y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(GL, FLOOR_Y); ctx.lineTo(GR, FLOOR_Y); ctx.stroke();

    // Gold corner accents
    ctx.strokeStyle = P.gold; ctx.lineWidth = 2;
    const cs = 18;
    ctx.beginPath(); ctx.moveTo(GL+cs,FLOOR_Y); ctx.lineTo(GL,FLOOR_Y); ctx.lineTo(GL,FLOOR_Y-cs); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(GR-cs,FLOOR_Y); ctx.lineTo(GR,FLOOR_Y); ctx.lineTo(GR,FLOOR_Y-cs); ctx.stroke();

    diamond(ctx, GL, H / 2, 5);
    diamond(ctx, GR, H / 2, 5);
  }, [diamond]);

  // ── Ceiling / Danger zone ───────────────────────────────────
  const drawCeiling = useCallback((ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = 'rgba(200,0,0,0.055)';
    ctx.fillRect(GL, 0, GW, CEILING_Y);

    ctx.save();
    ctx.strokeStyle = P.danger;
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.75;
    ctx.setLineDash([7, 5]);
    ctx.beginPath(); ctx.moveTo(GL, CEILING_Y); ctx.lineTo(GR, CEILING_Y); ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = 'bold 9px "Noto Sans JP", sans-serif';
    ctx.fillStyle = P.danger;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText('DANGER LINE', GR - 4, CEILING_Y - 3);
    ctx.restore();
  }, []);

  // ── HUD ─────────────────────────────────────────────────────
  const drawHUD = useCallback((ctx: CanvasRenderingContext2D, st: GS) => {
    const py = 6, ph = CEILING_Y - 12;

    // Score panel
    const sx = GL + 4, sw = 116;
    ctx.fillStyle = P.panel;
    rrect(ctx, sx, py, sw, ph, 5); ctx.fill();
    ctx.strokeStyle = P.panelBrd; ctx.lineWidth = 1;
    rrect(ctx, sx, py, sw, ph, 5); ctx.stroke();
    ctx.fillStyle = P.gold; rrect(ctx, sx, py, sw, 3, 3); ctx.fill();

    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = P.gold;
    ctx.font = 'bold 8px "Noto Sans JP", sans-serif';
    ctx.fillText('S C O R E', sx + 8, py + 8);

    const scoreStr = String(st.score);
    ctx.fillStyle = P.text;
    ctx.font = `bold ${scoreStr.length > 6 ? 14 : 18}px "Oswald", "Arial Narrow", sans-serif`;
    ctx.fillText(scoreStr, sx + 8, py + 20);

    ctx.fillStyle = P.gold;
    ctx.font = 'bold 8px "Noto Sans JP", sans-serif';
    ctx.fillText('B E S T', sx + 8, py + 44);
    ctx.fillStyle = P.textDim;
    ctx.font = '12px "Oswald", "Arial Narrow", sans-serif';
    ctx.fillText(String(st.highScore), sx + 8, py + 55);

    // Next monster panel
    const nw = 80, nx = GR - 4 - nw;
    ctx.fillStyle = P.panel;
    rrect(ctx, nx, py, nw, ph, 5); ctx.fill();
    ctx.strokeStyle = P.panelBrd; ctx.lineWidth = 1;
    rrect(ctx, nx, py, nw, ph, 5); ctx.stroke();
    ctx.fillStyle = P.gold; rrect(ctx, nx, py, nw, 3, 3); ctx.fill();

    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = P.gold;
    ctx.font = 'bold 8px "Noto Sans JP", sans-serif';
    ctx.fillText('N E X T', nx + nw / 2, py + 8);

    const nm  = MONSTERS[st.nextLevel];
    const nmr = Math.min(nm.radius, 28);
    const sc  = nmr / nm.radius;
    ctx.save();
    ctx.translate(nx + nw / 2, py + ph / 2 + 8);
    ctx.scale(sc, sc);
    drawMonster(ctx, 0, 0, st.nextLevel, 0.85);
    ctx.restore();

    // Name with a dark backing pill for legibility
    const nameShort = nm.name.length > 7 ? nm.name.slice(0, 6) + '…' : nm.name;
    ctx.font = 'bold 9px "Noto Sans JP", sans-serif';
    const tw = ctx.measureText(nameShort).width;
    const pillW = Math.min(nw - 6, tw + 12);
    const pillH = 14;
    const pillX = nx + nw / 2 - pillW / 2;
    const pillY = py + ph - pillH - 3;
    ctx.fillStyle = 'rgba(0,0,0,0.78)';
    rrect(ctx, pillX, pillY, pillW, pillH, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(200,160,48,0.6)'; ctx.lineWidth = 1;
    rrect(ctx, pillX, pillY, pillW, pillH, 7); ctx.stroke();
    ctx.fillStyle = '#ffe9a8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(nameShort, nx + nw / 2, pillY + pillH / 2 + 0.5);

    // Current monster at drop position
    if (st.phase === 'playing') {
      drawMonster(ctx, st.dropX, DROP_Y, st.currentLevel);
      if (st.canDrop) {
        ctx.save();
        ctx.strokeStyle = 'rgba(180,180,255,0.25)';
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 7]);
        ctx.beginPath();
        ctx.moveTo(st.dropX, DROP_Y + MONSTERS[st.currentLevel].radius + 2);
        ctx.lineTo(st.dropX, FLOOR_Y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
  }, [drawMonster]);

  // ── Secret monster (？) — black blurred orb with white question mark
  const drawMystery = useCallback((ctx: CanvasRenderingContext2D, x: number, y: number, r: number) => {
    ctx.save();
    // soft black blurred orb
    ctx.shadowColor = 'rgba(0,0,0,0.95)';
    ctx.shadowBlur  = r * 0.9;
    const g = ctx.createRadialGradient(x - r * 0.25, y - r * 0.3, r * 0.1, x, y, r);
    g.addColorStop(0, '#2a2440');
    g.addColorStop(0.7, '#0a0814');
    g.addColorStop(1, '#000');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // faint purple mystic rim
    ctx.strokeStyle = 'rgba(150,70,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // white "？"
    ctx.shadowColor = 'rgba(160,90,255,0.9)';
    ctx.shadowBlur  = r * 0.35;
    ctx.fillStyle   = '#ffffff';
    ctx.font = `bold ${Math.max(10, r * 1.15)}px "Noto Sans JP", sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('？', x, y + r * 0.04);
    ctx.restore();
  }, []);

  // ── Trigger the "知らない人" grand-entrance cutscene ──────────
  const triggerSecretFx = useCallback(() => {
    const sparkles: { x: number; y: number; r: number; tw: number }[] = [];
    for (let i = 0; i < 80; i++) {
      sparkles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: 2.5 + Math.random() * 7,
        tw: Math.random() * Math.PI * 2,
      });
    }
    secretFxRef.current = { start: Date.now(), sparkles };
  }, []);

  // 4-pointed sparkle star path
  const star4 = useCallback((ctx: CanvasRenderingContext2D, x: number, y: number, R: number) => {
    const ri = R * 0.34;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const ang = (Math.PI / 4) * i - Math.PI / 2;
      const rad = i % 2 === 0 ? R : ri;
      const px = x + Math.cos(ang) * rad, py = y + Math.sin(ang) * rad;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }, []);

  // ── Floating score / combo popups ──────────────────────────
  const drawPopups = useCallback((ctx: CanvasRenderingContext2D) => {
    const now = Date.now();
    const arr = popupsRef.current;
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      const dur = p.big ? 1150 : 950;
      const e = now - p.start;
      if (e >= dur) { arr.splice(i, 1); continue; }
      const t = e / dur;
      const rise = (p.big ? 50 : 38) * t;
      let alpha = 1;
      if (t < 0.14) alpha = t / 0.14;
      else if (t > 0.62) alpha = 1 - (t - 0.62) / 0.38;
      let scale = 1;
      if (t < 0.2) scale = 0.5 + 0.85 * (t / 0.2);
      else if (t < 0.34) scale = 1.35 - 0.35 * ((t - 0.2) / 0.14);

      ctx.save();
      ctx.globalAlpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
      ctx.translate(p.x, p.y - rise);
      ctx.scale(scale, scale);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${p.big ? 22 : 16}px "Noto Sans JP", sans-serif`;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(40,18,0,0.85)';
      ctx.lineWidth = p.big ? 5 : 4;
      ctx.strokeText(p.text, 0, 0);
      const g = ctx.createLinearGradient(0, -12, 0, 12);
      if (p.big) { g.addColorStop(0, '#fff0c0'); g.addColorStop(0.5, '#ff9a30'); g.addColorStop(1, '#ff3d20'); }
      else { g.addColorStop(0, '#fff6d0'); g.addColorStop(0.5, '#ffe070'); g.addColorStop(1, '#ffb020'); }
      ctx.fillStyle = g;
      ctx.shadowColor = p.big ? 'rgba(255,120,0,0.9)' : 'rgba(255,200,60,0.8)';
      ctx.shadowBlur = p.big ? 16 : 10;
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
    }
  }, []);

  // ── Draw the cutscene overlay (sparkles + RPG text) ─────────
  const drawSecretFx = useCallback((ctx: CanvasRenderingContext2D) => {
    const fx = secretFxRef.current;
    if (!fx) return;
    const DUR = 4800;
    const e = Date.now() - fx.start;
    if (e >= DUR) { secretFxRef.current = null; return; }

    const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    // overall envelope (fade in / out)
    const env = e < 300 ? e / 300 : e > DUR - 900 ? (DUR - e) / 900 : 1;

    ctx.save();

    // 0. dark dramatic tint so sparkles pop
    ctx.fillStyle = `rgba(8,4,24,${0.45 * env})`;
    ctx.fillRect(0, 0, W, H);

    // 1. opening flash
    if (e < 480) {
      ctx.fillStyle = `rgba(255,242,210,${(1 - e / 480) * 0.85})`;
      ctx.fillRect(0, 0, W, H);
    }

    // 2. rotating golden light rays from the focal point
    const fx0 = CX, fy0 = H * 0.42;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(fx0, fy0);
    ctx.rotate(e * 0.0006);
    ctx.globalAlpha = 0.16 * env;
    const rays = 14;
    for (let i = 0; i < rays; i++) {
      ctx.rotate((Math.PI * 2) / rays);
      const grd = ctx.createLinearGradient(0, 0, 0, -H);
      grd.addColorStop(0, 'rgba(255,225,140,0.5)');
      grd.addColorStop(1, 'rgba(255,225,140,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(-8, 0);
      ctx.lineTo(8, 0);
      ctx.lineTo(2, -H);
      ctx.lineTo(-2, -H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // 3. twinkling sparkles all over the screen
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const s of fx.sparkles) {
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(e * 0.009 + s.tw));
      const R = s.r * tw;
      ctx.globalAlpha = env * tw;
      ctx.shadowColor = 'rgba(255,225,150,0.9)';
      ctx.shadowBlur = R * 2;
      ctx.fillStyle = '#fff6da';
      star4(ctx, s.x, s.y, R);
      ctx.fill();
    }
    ctx.restore();

    // 4. RPG message: 「知らない人が現れた！」
    {
      const le = e - 150;
      let a1 = 0, sc1 = 1;
      if (le >= 0) {
        if (le < 500) { a1 = le / 500; sc1 = 0.6 + 0.52 * (le / 500); }
        else if (le < 680) { a1 = 1; sc1 = 1.12 - 0.12 * ((le - 500) / 180); }
        else if (le < 2700) { a1 = 1; sc1 = 1; }
        else if (le < 3300) { a1 = 1 - (le - 2700) / 600; sc1 = 1; }
      }
      if (a1 > 0) {
        const ty = H * 0.4;
        ctx.save();
        ctx.globalAlpha = clamp01(a1);
        ctx.translate(CX, ty);
        ctx.scale(sc1, sc1);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 27px "Noto Serif JP", "Yu Mincho", serif';
        // glow
        ctx.shadowColor = 'rgba(180,90,255,0.9)';
        ctx.shadowBlur = 22;
        // gold gradient fill
        const g = ctx.createLinearGradient(0, -18, 0, 18);
        g.addColorStop(0, '#fff6d0');
        g.addColorStop(0.5, '#ffdf70');
        g.addColorStop(1, '#c8901f');
        ctx.fillStyle = g;
        ctx.strokeStyle = 'rgba(40,10,60,0.9)';
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';
        ctx.strokeText('知らない人が現れた！', 0, 0);
        ctx.fillText('知らない人が現れた！', 0, 0);
        ctx.restore();
      }
    }

    // 5. faint whisper: who are you ?
    {
      const le = e - 2500;
      let a2 = 0;
      if (le >= 0) {
        if (le < 800) a2 = (le / 800) * 0.6;
        else if (le < 1500) a2 = 0.6;
        else if (le < 2300) a2 = 0.6 * (1 - (le - 1500) / 800);
      }
      if (a2 > 0) {
        ctx.save();
        ctx.globalAlpha = clamp01(a2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'italic 22px "Noto Serif JP", Georgia, serif';
        ctx.shadowColor = 'rgba(160,120,255,0.8)';
        ctx.shadowBlur = 18;
        ctx.fillStyle = 'rgba(225,215,255,0.95)';
        ctx.fillText('who are you ?', CX, H * 0.52);
        ctx.restore();
      }
    }

    ctx.restore();
  }, [star4]);

  // ── Ranking list (shared by TOP and GAME OVER) ─────────────
  const drawRanking = useCallback((
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, rowH: number, maxRows: number, highlightIdx: number,
  ) => {
    const rows = rankingRef.current.slice(0, maxRows);
    if (rows.length === 0) {
      ctx.fillStyle = P.textDim;
      ctx.font = '10px "Noto Sans JP", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('まだ記録がありません', x + w / 2, y + rowH / 2);
      return;
    }
    rows.forEach((e, i) => {
      const ry = y + i * rowH;
      const cy = ry + rowH / 2;
      const hl = i === highlightIdx;
      if (hl) {
        ctx.fillStyle = 'rgba(255,210,80,0.18)';
        rrect(ctx, x, ry + 1, w, rowH - 2, 4); ctx.fill();
        ctx.strokeStyle = 'rgba(255,210,80,0.5)'; ctx.lineWidth = 1;
        rrect(ctx, x, ry + 1, w, rowH - 2, 4); ctx.stroke();
      }
      const medal = i === 0 ? '#ffd24a' : i === 1 ? '#cfd4dd' : i === 2 ? '#d8945a' : P.textDim;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = medal;
      ctx.font = 'bold 13px "Oswald", "Arial Narrow", sans-serif';
      ctx.fillText(String(i + 1), x + 8, cy);

      ctx.fillStyle = hl ? '#fff3c0' : P.text;
      ctx.font = '11px "Noto Sans JP", sans-serif';
      const name = e.name.length > 7 ? e.name.slice(0, 7) + '…' : e.name;
      ctx.fillText(name, x + 26, cy);

      ctx.textAlign = 'right';
      ctx.fillStyle = P.goldBrt;
      ctx.font = 'bold 14px "Oswald", "Arial Narrow", sans-serif';
      ctx.fillText(String(e.score), x + w - 92, cy);

      ctx.fillStyle = P.textDim;
      ctx.font = '9px "Noto Sans JP", sans-serif';
      const ev = evoName(e.maxLevel);
      ctx.fillText(ev.length > 7 ? ev.slice(0, 7) : ev, x + w - 6, cy);
    });
  }, []);

  // ── Start screen ────────────────────────────────────────────
  const drawStart = useCallback((ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = 'rgba(4,4,20,0.9)';
    ctx.fillRect(0, 0, W, H);

    // Title — no frame, a single eerie line: 「知らない人」
    {
      const t = Date.now();
      const flicker = 0.82 + 0.18 * Math.sin(t * 0.013) + (Math.random() < 0.06 ? -0.25 : 0);
      const jitter = Math.sin(t * 0.04) * 0.6;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = Math.max(0.5, Math.min(1, flicker));
      ctx.font = 'bold 46px "Noto Serif JP", "Yu Mincho", serif';
      const ty = 132 + jitter;
      // blood-red glow
      ctx.shadowColor = 'rgba(180,0,0,0.95)';
      ctx.shadowBlur = 26;
      // jagged dark outline
      ctx.lineJoin = 'miter';
      ctx.miterLimit = 2;
      ctx.strokeStyle = '#1a0000';
      ctx.lineWidth = 6;
      ctx.strokeText('知らない人', CX, ty);
      // blood-red gradient fill
      const g = ctx.createLinearGradient(0, ty - 26, 0, ty + 26);
      g.addColorStop(0, '#ff5a4a');
      g.addColorStop(0.5, '#c40000');
      g.addColorStop(1, '#5e0000');
      ctx.fillStyle = g;
      ctx.fillText('知らない人', CX, ty);
      // faint inner highlight
      ctx.shadowBlur = 0;
      ctx.globalAlpha *= 0.25;
      ctx.fillStyle = '#ff9a8a';
      ctx.fillText('知らない人', CX, ty - 1);
      ctx.restore();
    }

    // Name field label (the actual <input> is an HTML overlay)
    ctx.fillStyle = P.gold;
    ctx.font = 'bold 10px "Noto Sans JP", sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('プレイヤー名（任意）', CX, 220);

    // Start button
    const b = START_BTN;
    const bg = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
    bg.addColorStop(0, '#3a2a00'); bg.addColorStop(0.5, '#c8a030'); bg.addColorStop(1, '#3a2a00');
    ctx.fillStyle = bg;
    rrect(ctx, b.x, b.y, b.w, b.h, 8); ctx.fill();
    ctx.strokeStyle = P.goldBrt; ctx.lineWidth = 1.5;
    rrect(ctx, b.x, b.y, b.w, b.h, 8); ctx.stroke();
    ctx.shadowColor = P.goldBrt; ctx.shadowBlur = 12;
    ctx.fillStyle = '#fffadc';
    ctx.font = 'bold 15px "Noto Sans JP", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚔  ゲームスタート  ⚔', CX, b.y + b.h / 2);
    ctx.shadowBlur = 0;

    // Evolution route — all 11 monsters, last one is a secret
    const preY = 360;
    ctx.fillStyle = P.textDim;
    ctx.font = '9px "Noto Sans JP", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('— 進化ルート —', CX, preY);
    const shown = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const n = shown.length;
    const x0 = 20, x1 = W - 20;
    const stepX = (x1 - x0) / (n - 1);
    const pr = 13;
    shown.forEach((lvl, i) => {
      const px = x0 + i * stepX;
      const py = preY + 30;
      if (lvl === MAX_LEVEL) {
        drawMystery(ctx, px, py, pr);
      } else {
        const sc = pr / MONSTERS[lvl].radius;
        ctx.save();
        ctx.translate(px, py);
        ctx.scale(sc, sc);
        drawMonster(ctx, 0, 0, lvl, 0.95);
        ctx.restore();
      }
      if (i < n - 1) {
        ctx.fillStyle = P.gold;
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('›', px + stepX / 2, py);
      }
    });

    // Ranking panel
    const rx = 34, ry = 418, rw = W - 68, rh = 188;
    ctx.fillStyle = P.panel;
    rrect(ctx, rx, ry, rw, rh, 8); ctx.fill();
    ctx.strokeStyle = P.panelBrd; ctx.lineWidth = 1;
    rrect(ctx, rx, ry, rw, rh, 8); ctx.stroke();
    ctx.fillStyle = P.gold; rrect(ctx, rx, ry, rw, 3, 3); ctx.fill();
    ctx.fillStyle = P.gold;
    ctx.font = 'bold 11px "Noto Sans JP", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('🏆  ランキング  TOP5', rx + rw / 2, ry + 8);
    drawRanking(ctx, rx + 6, ry + 26, rw - 12, 30, 5, -1);
  }, [diamond, drawMonster, drawMystery, drawRanking]);

  // ── Game over screen ────────────────────────────────────────
  const drawGameOver = useCallback((ctx: CanvasRenderingContext2D, st: GS) => {
    ctx.fillStyle = 'rgba(4,4,20,0.9)';
    ctx.fillRect(0, 0, W, H);

    const bx = 24, by = 30, bw = W - 48, bh = 612;
    ctx.fillStyle = P.panel;
    rrect(ctx, bx, by, bw, bh, 12); ctx.fill();
    ctx.strokeStyle = '#800000'; ctx.lineWidth = 2;
    rrect(ctx, bx, by, bw, bh, 12); ctx.stroke();
    diamond(ctx, bx, by, 7); diamond(ctx, bx + bw, by, 7);
    diamond(ctx, bx, by + bh, 7); diamond(ctx, bx + bw, by + bh, 7);

    ctx.textAlign = 'center';
    ctx.shadowColor = '#ff0000'; ctx.shadowBlur = 18;
    ctx.fillStyle = '#ff5050';
    ctx.font = 'bold 27px "Noto Serif JP", serif';
    ctx.textBaseline = 'top';
    ctx.fillText('GAME OVER', CX, by + 16);
    ctx.shadowBlur = 0;

    // Player name
    const nm = (playerNameRef.current.trim() || 'ぼうけんしゃ').slice(0, 10);
    ctx.fillStyle = P.text;
    ctx.font = '11px "Noto Sans JP", sans-serif';
    ctx.fillText(`${nm} の きろく`, CX, by + 52);

    // Score
    ctx.shadowColor = P.goldBrt; ctx.shadowBlur = 10;
    ctx.fillStyle = P.goldBrt;
    ctx.font = 'bold 38px "Oswald", "Arial Narrow", sans-serif';
    ctx.fillText(String(st.score), CX, by + 70);
    ctx.shadowBlur = 0;

    const isNew = st.score > 0 && lastRankIdxRef.current === 0;
    ctx.fillStyle = isNew ? '#ff9050' : P.gold;
    ctx.font = isNew ? 'bold 11px "Noto Sans JP"' : '10px "Noto Sans JP"';
    ctx.fillText(isNew ? '🎉  NEW RECORD!  🎉' : `ベスト: ${st.highScore}`, CX, by + 118);

    // Max evolution reached (secret masked) — uses the real maxLevel
    ctx.fillStyle = P.textDim;
    ctx.font = '10px "Noto Sans JP", sans-serif';
    ctx.fillText('最大進化: ' + evoName(st.maxLevel), CX, by + 138);

    // Divider
    ctx.strokeStyle = P.gold; ctx.lineWidth = 1; ctx.globalAlpha = 0.3;
    ctx.beginPath(); ctx.moveTo(bx + 20, by + 162); ctx.lineTo(bx + bw - 20, by + 162); ctx.stroke();
    ctx.globalAlpha = 1;

    // Ranking
    ctx.fillStyle = P.gold;
    ctx.font = 'bold 11px "Noto Sans JP", sans-serif';
    ctx.fillText('🏆  ランキング  BEST10', CX, by + 172);
    drawRanking(ctx, bx + 14, by + 192, bw - 28, 28, 8, lastRankIdxRef.current);

    // Retry button
    const b = GO_BTN;
    const bg = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
    bg.addColorStop(0, '#1a0030'); bg.addColorStop(0.5, '#6030c0'); bg.addColorStop(1, '#1a0030');
    ctx.fillStyle = bg;
    rrect(ctx, b.x, b.y, b.w, b.h, 8); ctx.fill();
    ctx.strokeStyle = '#a060ff'; ctx.lineWidth = 1.5;
    rrect(ctx, b.x, b.y, b.w, b.h, 8); ctx.stroke();
    ctx.fillStyle = '#f0e0ff';
    ctx.font = 'bold 15px "Noto Sans JP", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚔  もう一度挑戦  ⚔', CX, b.y + b.h / 2);

    // Screenshot button (saves the final board with name + score)
    const sb = GO_SHOT_BTN;
    const sg = ctx.createLinearGradient(sb.x, sb.y, sb.x, sb.y + sb.h);
    sg.addColorStop(0, '#06243a'); sg.addColorStop(0.5, '#1c84b8'); sg.addColorStop(1, '#06243a');
    ctx.fillStyle = sg;
    rrect(ctx, sb.x, sb.y, sb.w, sb.h, 8); ctx.fill();
    ctx.strokeStyle = '#5ec8ff'; ctx.lineWidth = 1.5;
    rrect(ctx, sb.x, sb.y, sb.w, sb.h, 8); ctx.stroke();
    ctx.fillStyle = '#e6f6ff';
    ctx.font = 'bold 13px "Noto Sans JP", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📷  盤面を保存（スクショ）', CX, sb.y + sb.h / 2);
  }, [diamond, drawRanking]);

  // ── Save a screenshot of the final board + name/score watermark ──
  const saveScreenshot = useCallback(() => {
    const snap = snapshotRef.current;
    if (!snap) return;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const octx = out.getContext('2d');
    if (!octx) return;
    octx.drawImage(snap, 0, 0);
    // Unobtrusive watermark: name + score, bottom-left, semi-transparent
    const nm = (playerNameRef.current.trim() || 'ぼうけんしゃ').slice(0, 10);
    const label = `${nm}  ${gs.current.score} pts  ｜ スぽりんカゲーム`;
    octx.font = 'bold 11px "Noto Sans JP", sans-serif';
    octx.textAlign = 'left';
    octx.textBaseline = 'bottom';
    octx.shadowColor = 'rgba(0,0,0,0.7)';
    octx.shadowBlur = 3;
    octx.globalAlpha = 0.72;
    octx.fillStyle = '#ffe9a8';
    octx.fillText(label, 10, H - 8);
    octx.globalAlpha = 1;
    try {
      out.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `sporinka_${gs.current.score}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, 'image/png');
    } catch { /* */ }
  }, []);

  // ── Spawn a monster body ────────────────────────────────────
  const spawnMonster = useCallback((
    Matter: typeof import('matter-js'),
    x: number, y: number,
    level: number,
  ) => {
    const engine = engineRef.current as import('matter-js').Engine;
    const m = MONSTERS[level];
    const opts = {
      restitution: 0.15,
      friction: 0.4,
      frictionStatic: 0.55,
      frictionAir: 0.012,
      density: 0.002,
      label: `monster_${level}`,
    };
    // Collision shape = the VISIBLE silhouette. Prefer the concave
    // outline (follows wings & body-wing notches via convex
    // decomposition); fall back to the convex hull, then a circle.
    let body: import('matter-js').Body | undefined;
    const sp = procRef.current.get(level);
    if (sp) {
      const s = (2 * m.radius * 1.05) / Math.min(sp.bw, sp.bh);
      const toVerts = (poly: Vec[]) => poly.map((v) => ({ x: (v.x - sp.cxh) * s, y: (v.y - sp.cyh) * s }));
      // 1) concave outline (decomposed into convex parts by poly-decomp)
      if (sp.outline.length >= 3) {
        try {
          const b = Matter.Bodies.fromVertices(
            x, y, [toVerts(sp.outline)] as unknown as import('matter-js').Vector[][], opts, true,
          );
          if (b && b.vertices && b.vertices.length >= 3) body = b;
        } catch { /* fall through */ }
      }
      // 2) convex hull
      if (!body && sp.hull.length >= 3) {
        try {
          const hullFn = Matter.Vertices.hull as unknown as (v: Vec[]) => Vec[];
          const hv = hullFn(toVerts(sp.hull));
          const b = Matter.Bodies.fromVertices(x, y, [hv] as unknown as import('matter-js').Vector[][], opts);
          if (b && b.vertices && b.vertices.length >= 3) body = b;
        } catch { /* fall through */ }
      }
    }
    if (!body) body = Matter.Bodies.circle(x, y, m.radius, opts);
    bodyDataRef.current.set(body.id, { monsterId: level, createdAt: Date.now(), isMerging: false });
    if (level > gs.current.maxLevel) gs.current.maxLevel = level;
    Matter.Composite.add(engine.world, body);
    return body;
  }, []);

  // ── Handle two same-level monsters merging ──────────────────
  const handleMerge = useCallback((
    Matter: typeof import('matter-js'),
    bodyA: import('matter-js').Body,
    bodyB: import('matter-js').Body,
  ) => {
    const engine = engineRef.current as import('matter-js').Engine;
    const dA = bodyDataRef.current.get(bodyA.id);
    const dB = bodyDataRef.current.get(bodyB.id);
    if (!dA || !dB) return;
    if (dA.monsterId !== dB.monsterId) return;
    if (dA.isMerging || dB.isMerging) return;
    if (mergingRef.current.has(bodyA.id) || mergingRef.current.has(bodyB.id)) return;

    const level = dA.monsterId;
    mergingRef.current.add(bodyA.id);
    mergingRef.current.add(bodyB.id);
    dA.isMerging = true;
    dB.isMerging = true;

    const mx = (bodyA.position.x + bodyB.position.x) / 2;
    const my = (bodyA.position.y + bodyB.position.y) / 2;

    setTimeout(() => {
      Matter.Composite.remove(engine.world, bodyA);
      Matter.Composite.remove(engine.world, bodyB);
      bodyDataRef.current.delete(bodyA.id);
      bodyDataRef.current.delete(bodyB.id);
      mergingRef.current.delete(bodyA.id);
      mergingRef.current.delete(bodyB.id);

      // Combo: merges within a short window of each other chain up
      const now = Date.now();
      if (now - comboRef.current.lastTime < COMBO_WINDOW) comboRef.current.count++;
      else comboRef.current.count = 1;
      comboRef.current.lastTime = now;
      const combo = Math.min(comboRef.current.count, COMBO_CAP);

      const base = level === MAX_LEVEL ? SPECIAL_MERGE_SCORE : MONSTERS[level + 1].score;
      const gain = base * combo;
      gs.current.score += gain;

      // Floating popups (juicy feedback)
      popupsRef.current.push({ x: mx, y: my, text: `+${gain}`, start: now, big: level === MAX_LEVEL });
      if (combo >= 2) {
        popupsRef.current.push({ x: mx, y: my - 30, text: `${combo} COMBO!`, start: now, big: true });
      }

      if (level === MAX_LEVEL) {
        // special merge: both vanish, no new body
      } else {
        const nextLevel = level + 1;
        const newBody = spawnMonster(Matter, mx, Math.max(my, CEILING_Y + MONSTERS[nextLevel].radius), nextLevel);
        Matter.Body.setVelocity(newBody, {
          x: (bodyA.velocity.x + bodyB.velocity.x) * 0.3,
          y: -2.5,
        });
        Matter.Body.setAngularVelocity(newBody, (Math.random() - 0.5) * 0.04);
        // 知らない人 が初めて誕生した瞬間の演出
        if (nextLevel === MAX_LEVEL) triggerSecretFx();
      }

      const s = gs.current;
      if (s.score > s.highScore) {
        s.highScore = s.score;
        try { localStorage.setItem('sporinkaHighScore', String(s.score)); } catch { /* */ }
      }
    }, 80);
  }, [spawnMonster, triggerSecretFx]);

  // ── Drop current monster ────────────────────────────────────
  const drop = useCallback(() => {
    const Matter = MRef.current;
    if (!Matter) return;
    const st = gs.current;
    if (!st.canDrop || st.phase !== 'playing') return;
    if (Date.now() < coolRef.current) return;

    const r    = MONSTERS[st.currentLevel].radius;
    const clX  = Math.max(GL + r + 2, Math.min(GR - r - 2, st.dropX));
    const body = spawnMonster(Matter, clX, DROP_Y, st.currentLevel);
    // very slight initial spin; natural rolling comes from friction
    Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.03);

    st.currentLevel = st.nextLevel;
    st.nextLevel    = getRandomStartLevel();
    st.canDrop      = false;
    coolRef.current = Date.now() + DROP_COOLDOWN;
    setTimeout(() => { gs.current.canDrop = true; }, DROP_COOLDOWN);
  }, [spawnMonster]);

  // ── Initialize / restart game ───────────────────────────────
  const initGame = useCallback(async () => {
    cancelAnimationFrame(rafRef.current);

    const Matter = MRef.current ?? (await import('matter-js'));
    MRef.current = Matter;

    // Enable concave decomposition for collision shapes (wings etc.)
    try {
      const decomp = await import('poly-decomp');
      Matter.Common.setDecomp(decomp.default ?? decomp);
    } catch { /* falls back to convex hull */ }

    // Clear old world
    if (engineRef.current) {
      Matter.Engine.clear(engineRef.current as import('matter-js').Engine);
    }
    bodyDataRef.current.clear();
    mergingRef.current.clear();

    let hs = 0;
    try { hs = parseInt(localStorage.getItem('sporinkaHighScore') ?? '0') || 0; } catch { /* */ }

    const st = gs.current;
    st.score          = 0;
    st.highScore      = hs;
    st.currentLevel   = getRandomStartLevel();
    st.nextLevel      = getRandomStartLevel();
    st.dropX          = CX;
    st.canDrop        = true;
    st.gameOverFrames = 0;
    st.maxLevel       = st.currentLevel;
    st.phase          = 'playing';
    coolRef.current   = 0;
    secretFxRef.current = null;
    popupsRef.current = [];
    comboRef.current = { count: 0, lastTime: 0 };
    snapshotRef.current = null;

    // Physics world
    const engine = Matter.Engine.create({ gravity: { x: 0, y: 1.8 } });
    engineRef.current = engine;

    const ground = Matter.Bodies.rectangle(CX, H + 30, W + 40, 80,       { isStatic: true, label: 'ground', friction: 0.6 });
    const leftW  = Matter.Bodies.rectangle(GL / 2, H / 2, WALL + 2, H*2, { isStatic: true, label: 'wall',   friction: 0.4 });
    const rightW = Matter.Bodies.rectangle(GR + WALL/2, H/2, WALL+2, H*2,{ isStatic: true, label: 'wall',   friction: 0.4 });
    Matter.Composite.add(engine.world, [ground, leftW, rightW]);

    Matter.Events.on(engine, 'collisionStart', (event: import('matter-js').IEventCollision<import('matter-js').Engine>) => {
      for (const pair of event.pairs) {
        if (pair.bodyA.isStatic || pair.bodyB.isStatic) continue;
        handleMerge(Matter, pair.bodyA, pair.bodyB);
      }
    });

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    setUiPhase('playing');

    let last = 0;
    const loop = (ts: number) => {
      const dt = Math.min(ts - last, 33);
      last = ts;
      Matter.Engine.update(engine, dt > 0 ? dt : 16);

      // Safety clamp: stop any body from "flying away" (runaway
      // velocity / spin from collision resolution)
      const MAXV = 32, MAXW = 0.5;
      for (const b of Matter.Composite.allBodies(engine.world)) {
        if (b.isStatic) continue;
        const sp = Math.hypot(b.velocity.x, b.velocity.y);
        if (sp > MAXV) {
          Matter.Body.setVelocity(b, { x: (b.velocity.x / sp) * MAXV, y: (b.velocity.y / sp) * MAXV });
        }
        if (b.angularVelocity > MAXW || b.angularVelocity < -MAXW) {
          Matter.Body.setAngularVelocity(b, Math.max(-MAXW, Math.min(MAXW, b.angularVelocity)));
        }
      }

      const s = gs.current;

      // Game over detection: only once EVERY body has completely
      // stopped moving AND at least one rests above the danger line.
      if (s.phase === 'playing') {
        const bodies = Matter.Composite.allBodies(engine.world);
        const REST_V = 0.6, REST_W = 0.08; // "completely stopped" thresholds (polygon-friendly)
        let allResting = true;
        let anyOverLine = false;
        for (const b of bodies) {
          if (b.isStatic) continue;
          const d = bodyDataRef.current.get(b.id);
          if (!d || d.isMerging) continue;
          const speed = Math.hypot(b.velocity.x, b.velocity.y);
          if (speed > REST_V || Math.abs(b.angularVelocity) > REST_W) allResting = false;
          // ignore just-spawned bodies still falling from the top
          if (Date.now() - d.createdAt < 500) continue;
          const top = b.position.y - MONSTERS[d.monsterId].radius;
          if (top < CEILING_Y) anyOverLine = true;
        }
        // Require the resting+over-line state to persist briefly to
        // avoid a one-frame fluke; never trigger while anything moves.
        if (allResting && anyOverLine) s.gameOverFrames++;
        else s.gameOverFrames = 0;
        if (s.gameOverFrames > 25) {
          s.phase = 'gameover';
          if (s.score > s.highScore) {
            s.highScore = s.score;
            try { localStorage.setItem('sporinkaHighScore', String(s.score)); } catch { /* */ }
          }
          // Record this run in the ranking
          const name = (playerNameRef.current.trim() || 'ぼうけんしゃ').slice(0, 10);
          const { list, index } = insertRanking({ name, score: s.score, maxLevel: s.maxLevel });
          rankingRef.current = list;
          lastRankIdxRef.current = index;
          setUiPhase('gameover');
        }
      }

      // Render
      ctx.clearRect(0, 0, W, H);
      drawBG(ctx);
      drawWalls(ctx);
      drawCeiling(ctx);

      // Pulse factor for the danger outline (visibility)
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.012);
      const WARN = 22; // px below the line where the warning engages/releases

      const allBodies = Matter.Composite.allBodies(engine.world);
      for (const b of allBodies) {
        if (b.isStatic) continue;
        const d = bodyDataRef.current.get(b.id);
        if (!d) continue;
        const r = MONSTERS[d.monsterId].radius;
        drawMonster(ctx, b.position.x, b.position.y, d.monsterId, d.isMerging ? 0.5 : 1, b.angle);

        // Red danger outline when the block reaches / nears the GAME
        // OVER line; released once it drops a bit below it.
        if (!d.isMerging && (b.position.y - r) < CEILING_Y + WARN) {
          ctx.save();
          ctx.strokeStyle = `rgba(255,40,40,${0.55 + 0.45 * pulse})`;
          ctx.lineWidth = 3;
          ctx.shadowColor = 'rgba(255,0,0,0.9)';
          ctx.shadowBlur = 10 + 8 * pulse;
          ctx.beginPath();
          ctx.arc(b.position.x, b.position.y, r + 2, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }

      drawHUD(ctx, s);

      // Capture the final board ONCE for the screenshot (before the
      // game-over overlay is drawn over it)
      if (s.phase === 'gameover' && !snapshotRef.current) {
        const snap = document.createElement('canvas');
        snap.width = W; snap.height = H;
        snap.getContext('2d')?.drawImage(canvas, 0, 0);
        snapshotRef.current = snap;
      }

      drawPopups(ctx);
      drawSecretFx(ctx);
      if (s.phase === 'gameover') drawGameOver(ctx, s);

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [drawBG, drawWalls, drawCeiling, drawMonster, drawHUD, drawGameOver, drawPopups, drawSecretFx, handleMerge]);

  // ── Preload + preprocess monster images ─────────────────────
  useEffect(() => {
    MONSTERS.forEach((m) => {
      const img = new Image();
      img.onload = () => {
        try {
          const sp = buildSprite(img, { keepLargest: m.keepLargest, erase: m.erase });
          if (sp) procRef.current.set(m.id, sp);
        } catch { /* keep gradient fallback */ }
      };
      img.src = m.imageSrc;
      imgsRef.current.set(m.id, img);
    });
  }, []);

  // ── Start screen animation (mount) ─────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    gs.current.phase = 'start';
    const loop = () => {
      ctx.clearRect(0, 0, W, H);
      drawBG(ctx);
      drawWalls(ctx);
      drawCeiling(ctx);
      drawStart(ctx);
      if (gs.current.phase === 'start') {
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [drawBG, drawWalls, drawCeiling, drawStart]);

  // ── Responsive scale ────────────────────────────────────────
  useEffect(() => {
    const update = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      // Fit the board to BOTH the available width and height, and allow
      // it to grow beyond 1× (using the space freed by removing the header).
      const availW = (wrap.parentElement?.clientWidth ?? window.innerWidth) - 8;
      const availH = window.innerHeight - 48; // leave room for the footer
      const s = Math.max(0.2, Math.min(availW / W, availH / H, 2.2));
      scaleRef.current = s;
      wrap.style.transform       = `scale(${s})`;
      wrap.style.transformOrigin = 'top center';
      wrap.style.marginBottom    = `${(H * s - H)}px`;
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // ── Input: only track position via native listeners ─────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const toX = (clientX: number) => {
      const rect = canvas.getBoundingClientRect();
      return (clientX - rect.left) / scaleRef.current;
    };
    const onMove  = (e: MouseEvent) => { gs.current.dropX = Math.max(GL+5, Math.min(GR-5, toX(e.clientX))); };
    const onTouch = (e: TouchEvent) => { e.preventDefault(); gs.current.dropX = Math.max(GL+5, Math.min(GR-5, toX(e.touches[0].clientX))); };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('touchmove', onTouch, { passive: false });
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('touchmove', onTouch);
    };
  }, []);

  // ── Unified click handler (includes button hit-testing) ─────
  const handleClick = useCallback(async (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const s  = scaleRef.current;
    const cx = (clientX - rect.left) / s;
    const cy = (clientY - rect.top)  / s;
    const st = gs.current;

    const inBtn = (b: { x: number; y: number; w: number; h: number }) =>
      cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;

    if (st.phase === 'start') {
      if (inBtn(START_BTN)) {
        cancelAnimationFrame(rafRef.current);
        await initGame();
      }
    } else if (st.phase === 'gameover') {
      if (inBtn(GO_BTN)) {
        cancelAnimationFrame(rafRef.current);
        await initGame();
      } else if (inBtn(GO_SHOT_BTN)) {
        saveScreenshot();
      }
    } else {
      drop();
    }
  }, [initGame, drop, saveScreenshot]);

  return (
    <div style={{ width: '100%', display: 'flex', justifyContent: 'center', overflowX: 'hidden' }}>
      <div ref={wrapRef} style={{ position: 'relative', width: W, height: H }}>
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          style={{ display: 'block', width: W, height: H, cursor: 'crosshair', touchAction: 'none' }}
          onClick={(e) => handleClick(e.clientX, e.clientY)}
          onTouchEnd={(e) => {
            e.preventDefault();
            const t = e.changedTouches[0];
            gs.current.dropX = Math.max(GL + 5, Math.min(GR - 5,
              (t.clientX - (canvasRef.current?.getBoundingClientRect().left ?? 0)) / scaleRef.current
            ));
            handleClick(t.clientX, t.clientY);
          }}
        />
        {uiPhase === 'start' && (
          <input
            type="text"
            value={playerName}
            onChange={(e) => { setPlayerName(e.target.value); playerNameRef.current = e.target.value; }}
            maxLength={10}
            placeholder="なまえを入力"
            aria-label="プレイヤー名"
            style={{
              position: 'absolute',
              left: 90,
              top: 238,
              width: 220,
              height: 32,
              boxSizing: 'border-box',
              padding: '0 10px',
              background: 'rgba(10,10,30,0.92)',
              border: '1.5px solid #c8a030',
              borderRadius: 7,
              color: '#ffe9b0',
              textAlign: 'center',
              fontSize: 16,
              fontFamily: '"Noto Sans JP", sans-serif',
              outline: 'none',
              zIndex: 5,
            }}
          />
        )}
      </div>
    </div>
  );
}
