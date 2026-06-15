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
  overLineFrames: number; // safety-net timer: frames with a body over the line
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

// TOP menu button rects
const MENU_START_BTN = { w: 260, h: 52, x: CX - 130, y: 222 };
const MENU_RANK_BTN  = { w: 230, h: 44, x: CX - 115, y: 288 };
const MENU_SET_BTN   = { w: 230, h: 44, x: CX - 115, y: 344 };
const MENU_HOW_BTN   = { w: 230, h: 44, x: CX - 115, y: 400 };
// In-game / game-over button rects
const GO_BTN = { w: 184, h: 44, x: CX - 92, y: 532 };          // retry
const GO_VIEW_BTN = { w: 90, h: 38, x: CX - 92, y: 584 };      // view final board
const GO_SHOT_BTN = { w: 90, h: 38, x: CX + 2, y: 584 };       // save screenshot
// Buttons shown while gazing at the final board
const GO_BACK_BTN = { w: 112, h: 34, x: 12, y: 10 };
const GO_VSHOT_BTN = { w: 112, h: 34, x: W - 124, y: 10 };

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
interface Sprite {
  canvas: HTMLCanvasElement;
  bx: number; by: number; bw: number; bh: number; // opaque bounding box
  circles: { dx: number; dy: number; r: number }[]; // collision circles, offset from centroid (sprite px)
  cxh: number; cyh: number;                          // centroid (render + body alignment)
}

interface Circle { x: number; y: number; r: number; }

// Approximate the visible silhouette with a few inscribed circles
// (greedy max-inscribed-circle packing on a distance transform). A
// compound of these circles is very stable in Matter and naturally
// leaves concave notches (e.g. wing roots). Detached features (halo,
// flames, beads) are kept too — only tiny specks are dropped.
function packCircles(d: Uint8ClampedArray, w: number, h: number, maxCircles: number): Circle[] {
  // label opaque components (alpha > 80)
  const mask = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) mask[p] = d[p * 4 + 3] > 80 ? 1 : 0;
  const lbl = new Int32Array(w * h).fill(-1);
  const areas: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || lbl[s] >= 0) continue;
    const id = areas.length;
    const stk = [s]; lbl[s] = id; let a = 0;
    while (stk.length) {
      const p = stk.pop()!; a++;
      const px = p % w, py = (p / w) | 0;
      if (px > 0 && mask[p - 1] && lbl[p - 1] < 0) { lbl[p - 1] = id; stk.push(p - 1); }
      if (px < w - 1 && mask[p + 1] && lbl[p + 1] < 0) { lbl[p + 1] = id; stk.push(p + 1); }
      if (py > 0 && mask[p - w] && lbl[p - w] < 0) { lbl[p - w] = id; stk.push(p - w); }
      if (py < h - 1 && mask[p + w] && lbl[p + w] < 0) { lbl[p + w] = id; stk.push(p + w); }
    }
    areas.push(a);
  }
  if (!areas.length) return [];
  // keep body + detached features; drop tiny specks (< 2% of largest)
  const largest = Math.max(...areas);
  const minArea = Math.max(40, 0.02 * largest);
  for (let p = 0; p < w * h; p++) if (lbl[p] >= 0 && areas[lbl[p]] < minArea) mask[p] = 0;

  // distance transform (two-pass chamfer)
  const INF = 1e9, dist = new Float64Array(w * h);
  for (let p = 0; p < w * h; p++) dist[p] = mask[p] ? INF : 0;
  const relax = (p: number, q: number, c: number) => { if (dist[q] + c < dist[p]) dist[p] = dist[q] + c; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = y * w + x; if (!mask[p]) continue; if (x > 0) relax(p, p - 1, 1); if (y > 0) relax(p, p - w, 1); if (x > 0 && y > 0) relax(p, p - w - 1, 1.4142); if (x < w - 1 && y > 0) relax(p, p - w + 1, 1.4142); }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) { const p = y * w + x; if (!mask[p]) continue; if (x < w - 1) relax(p, p + 1, 1); if (y < h - 1) relax(p, p + w, 1); if (x < w - 1 && y < h - 1) relax(p, p + w + 1, 1.4142); if (x > 0 && y < h - 1) relax(p, p + w - 1, 1.4142); }

  // greedy packing
  const circles: Circle[] = [];
  const dwork = Float64Array.from(dist);
  let firstR = 0;
  for (let k = 0; k < maxCircles; k++) {
    let mp = -1, md = 0;
    for (let p = 0; p < w * h; p++) if (dwork[p] > md) { md = dwork[p]; mp = p; }
    if (mp < 0) break;
    if (k === 0) firstR = md;
    if (md < Math.max(2.5, firstR * 0.14)) break;
    const cx = mp % w, cy = (mp / w) | 0;
    circles.push({ x: cx, y: cy, r: md });
    const cr2 = md * md;
    const x0 = Math.max(0, (cx - md) | 0), x1 = Math.min(w - 1, (cx + md) | 0);
    const y0 = Math.max(0, (cy - md) | 0), y1 = Math.min(h - 1, (cy + md) | 0);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const dx = x - cx, dy = y - cy; if (dx * dx + dy * dy <= cr2) dwork[y * w + x] = 0; }
  }
  return circles;
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

  // Collision shape: pack the visible silhouette with inscribed circles
  // (stable compound body, with natural notches at wing roots).
  const packed = packCircles(d, w, h, 12);
  let cx0 = (minx + maxx + 2) / 2, cy0 = (miny + maxy + 2) / 2;
  if (packed.length) {
    // centroid = area-weighted (mass) centre of the circles
    let area = 0, sx = 0, sy = 0;
    for (const c of packed) { const a = c.r * c.r; area += a; sx += a * c.x; sy += a * c.y; }
    cx0 = sx / area; cy0 = sy / area;
  }
  const circles = packed.map((c) => ({ dx: c.x - cx0, dy: c.y - cy0, r: c.r }));

  return {
    canvas: c, bx: minx, by: miny, bw: maxx - minx + 1, bh: maxy - miny + 1,
    circles, cxh: cx0, cyh: cy0,
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
  const viewingRef    = useRef<boolean>(false); // gazing at the final board
  const bgmRef              = useRef<HTMLAudioElement | null>(null);
  const bgmGameoverRef      = useRef<HTMLAudioElement | null>(null);
  const seGattaiRef         = useRef<HTMLAudioElement | null>(null);
  const seShiranaihitoRef   = useRef<HTMLAudioElement | null>(null);
  const bgmOnRef            = useRef(true);
  const seOnRef             = useRef(true);

  const [bgmOn, setBgmOn]   = useState(true);
  const [seOn,  setSeOn]    = useState(true);
  const [modal, setModal]   = useState<null | 'ranking' | 'settings' | 'howto'>(null);
  const modalRef            = useRef<null | 'ranking' | 'settings' | 'howto'>(null);

  const gs = useRef<GS>({
    phase: 'start',
    score: 0,
    highScore: 0,
    currentLevel: 0,
    nextLevel: 1,
    dropX: CX,
    canDrop: false,
    gameOverFrames: 0,
    overLineFrames: 0,
    maxLevel: 0,
  });

  const [uiPhase, setUiPhase] = useState<Phase>('start');

  // Load saved ranking once on mount
  useEffect(() => { rankingRef.current = loadRanking(); }, []);

  // Load audio assets
  useEffect(() => {
    const bgm = new Audio('/bgm/top.mp3');
    bgm.loop = true;
    bgm.volume = 0.4;
    bgmRef.current = bgm;
    const bgmGO = new Audio('/bgm/gameover.mp3');
    bgmGO.loop = false;
    bgmGO.volume = 0.5;
    bgmGameoverRef.current = bgmGO;
    const se = new Audio('/se/gattai.wav');
    se.volume = 0.7;
    seGattaiRef.current = se;
    const seS = new Audio('/se/shiranaihito.wav');
    seS.volume = 0.8;
    seShiranaihitoRef.current = seS;
    return () => { bgm.pause(); };
  }, []);

  useEffect(() => {
    bgmOnRef.current = bgmOn;
    const bgm = bgmRef.current;
    if (!bgm) return;
    if (!bgmOn) {
      bgm.pause();
      bgmGameoverRef.current?.pause();
    } else {
      const phase = gs.current.phase;
      if (phase === 'start' || phase === 'playing') bgm.play().catch(() => {});
      else if (phase === 'gameover') bgmGameoverRef.current?.play().catch(() => {});
    }
  }, [bgmOn]);

  useEffect(() => { seOnRef.current = seOn; }, [seOn]);

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
    ctx.fillStyle = 'rgba(4,4,20,0.92)';
    ctx.fillRect(0, 0, W, H);

    // Acrostic title (big red leading chars read downward = スイガゲーム)
    {
      const lines: [string, string][] = [
        ['ス', 'ごい'],
        ['イ', 'きおいで'],
        ['ガ', 'ったいさせたら最後に知らない人がでてきて唖然とした'],
        ['ゲーム', ''],
      ];
      const x0 = 22, lh = 44, baseY = 60;
      ctx.save();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      lines.forEach(([red, white], i) => {
        const by = baseY + i * lh;
        let x = x0;
        ctx.font = 'bold 38px "Noto Serif JP", "Yu Mincho", serif';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 4.5;
        ctx.strokeStyle = 'rgba(40,0,0,0.9)';
        ctx.shadowColor = 'rgba(230,0,0,0.9)';
        ctx.shadowBlur = 16;
        const rg = ctx.createLinearGradient(0, by - 34, 0, by + 6);
        rg.addColorStop(0, '#ff6a5a');
        rg.addColorStop(1, '#bd0000');
        ctx.strokeText(red, x, by);
        ctx.fillStyle = rg;
        ctx.fillText(red, x, by);
        x += ctx.measureText(red).width + 3;
        ctx.shadowBlur = 0;
        if (white) {
          ctx.font = 'bold 11px "Noto Sans JP", sans-serif';
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = 'rgba(0,0,0,0.55)';
          ctx.fillStyle = '#f4f4ff';
          ctx.strokeText(white, x, by - 6);
          ctx.fillText(white, x, by - 6);
        }
      });
      ctx.restore();
    }

    // Separator line under title
    ctx.save();
    ctx.strokeStyle = P.gold;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.moveTo(22, 212); ctx.lineTo(W - 22, 212);
    ctx.stroke();
    ctx.restore();

    // Menu button helper
    const menuBtn = (
      b: { x: number; y: number; w: number; h: number },
      label: string,
      primary: boolean,
    ) => {
      const g = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
      if (primary) {
        g.addColorStop(0, '#3a2a00'); g.addColorStop(0.5, '#c8a030'); g.addColorStop(1, '#3a2a00');
      } else {
        g.addColorStop(0, '#0a0a24'); g.addColorStop(0.5, '#16163c'); g.addColorStop(1, '#0a0a24');
      }
      ctx.fillStyle = g;
      rrect(ctx, b.x, b.y, b.w, b.h, 10); ctx.fill();
      ctx.strokeStyle = primary ? P.goldBrt : P.gold;
      ctx.lineWidth = primary ? 2 : 1.5;
      rrect(ctx, b.x, b.y, b.w, b.h, 10); ctx.stroke();
      if (primary) { ctx.shadowColor = P.goldBrt; ctx.shadowBlur = 14; }
      ctx.fillStyle = primary ? '#fffadc' : P.text;
      ctx.font = `bold ${primary ? 17 : 14}px "Noto Sans JP", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2);
      ctx.shadowBlur = 0;
    };

    menuBtn(MENU_START_BTN, '⚔  ゲームスタート  ⚔', true);
    menuBtn(MENU_RANK_BTN,  '🏆  ランキング', false);
    menuBtn(MENU_SET_BTN,   '⚙  セッティング', false);
    menuBtn(MENU_HOW_BTN,   '📖  遊び方', false);
  }, []);

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

    // helper: gradient button
    const btn = (
      r: { x: number; y: number; w: number; h: number },
      c0: string, c1: string, edge: string, fg: string, label: string, fs: number,
    ) => {
      const g = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
      g.addColorStop(0, c0); g.addColorStop(0.5, c1); g.addColorStop(1, c0);
      ctx.fillStyle = g;
      rrect(ctx, r.x, r.y, r.w, r.h, 8); ctx.fill();
      ctx.strokeStyle = edge; ctx.lineWidth = 1.5;
      rrect(ctx, r.x, r.y, r.w, r.h, 8); ctx.stroke();
      ctx.fillStyle = fg;
      ctx.font = `bold ${fs}px "Noto Sans JP", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
    };

    // Retry (primary) + view-board + screenshot (secondary row)
    btn(GO_BTN, '#1a0030', '#6030c0', '#a060ff', '#f0e0ff', '⚔  もう一度挑戦  ⚔', 15);
    btn(GO_VIEW_BTN, '#0a2a10', '#2a9c46', '#6cff9a', '#e6ffe9', '👁 盤面を見る', 12);
    btn(GO_SHOT_BTN, '#06243a', '#1c84b8', '#5ec8ff', '#e6f6ff', '📷 保存', 12);
  }, [diamond, drawRanking]);

  // ── Board-gazing overlay (final board visible, minimal chrome) ──
  const drawBoardView = useCallback((ctx: CanvasRenderingContext2D) => {
    const button = (r: { x: number; y: number; w: number; h: number }, label: string, edge: string) => {
      ctx.fillStyle = 'rgba(6,6,24,0.82)';
      rrect(ctx, r.x, r.y, r.w, r.h, 8); ctx.fill();
      ctx.strokeStyle = edge; ctx.lineWidth = 1.5;
      rrect(ctx, r.x, r.y, r.w, r.h, 8); ctx.stroke();
      ctx.fillStyle = '#f0e8d0';
      ctx.font = 'bold 13px "Noto Sans JP", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2);
    };
    button(GO_BACK_BTN, '← もどる', '#c8a030');
    button(GO_VSHOT_BTN, '📷 保存', '#5ec8ff');
  }, []);

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
    const label = `${nm}  ${gs.current.score} pts  ｜ スイガゲーム`;
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
        a.download = `suiga_${gs.current.score}.png`;
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
    // Collision shape = a few inscribed circles (compound body). Circles
    // are the most stable Matter primitive and naturally leave concave
    // notches (wing roots). Falls back to a single circle.
    let body: import('matter-js').Body | undefined;
    const sp = procRef.current.get(level);
    if (sp && sp.circles.length >= 1) {
      const s = (2 * m.radius * 1.05) / Math.min(sp.bw, sp.bh);
      try {
        if (sp.circles.length === 1) {
          body = Matter.Bodies.circle(x, y, Math.max(2, sp.circles[0].r * s), opts);
        } else {
          const parts = sp.circles.map((c) =>
            Matter.Bodies.circle(x + c.dx * s, y + c.dy * s, Math.max(2, c.r * s), opts));
          body = Matter.Body.create({ parts, label: `monster_${level}`, frictionAir: 0.012 });
        }
      } catch { /* fall through to circle */ }
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

      // Merge SE
      if (seOnRef.current) {
        if (level === MAX_LEVEL) {
          if (seShiranaihitoRef.current) {
            const clone = seShiranaihitoRef.current.cloneNode() as HTMLAudioElement;
            clone.play().catch(() => {});
          }
        } else if (seGattaiRef.current) {
          const clone = seGattaiRef.current.cloneNode() as HTMLAudioElement;
          clone.play().catch(() => {});
        }
      }

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
    st.overLineFrames = 0;
    st.maxLevel       = st.currentLevel;
    st.phase          = 'playing';
    coolRef.current   = 0;
    secretFxRef.current = null;
    popupsRef.current = [];
    comboRef.current = { count: 0, lastTime: 0 };
    snapshotRef.current = null;
    viewingRef.current = false;

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
        // compound bodies report child parts → resolve to the parent
        const a = pair.bodyA.parent ?? pair.bodyA;
        const b = pair.bodyB.parent ?? pair.bodyB;
        if (a === b) continue; // internal part-vs-part collision
        handleMerge(Matter, a, b);
      }
    });

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    setUiPhase('playing');
    const goAudio = bgmGameoverRef.current;
    if (goAudio) { goAudio.pause(); goAudio.currentTime = 0; }
    const bgm = bgmRef.current;
    if (bgm && bgmOnRef.current) { bgm.currentTime = 0; bgm.play().catch(() => {}); }
    else if (bgm) { bgm.pause(); bgm.currentTime = 0; }

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
        // Fast path: fully stopped + over the line.
        if (allResting && anyOverLine) s.gameOverFrames++;
        else s.gameOverFrames = 0;
        // Safety net: a block lingering over the line for a sustained
        // time ends the game even if the pile keeps micro-jittering.
        if (anyOverLine) s.overLineFrames++;
        else s.overLineFrames = 0;
        if (s.gameOverFrames > 25 || s.overLineFrames > 200) {
          s.phase = 'gameover';
          bgmRef.current?.pause();
          const go = bgmGameoverRef.current;
          if (go && bgmOnRef.current) { go.currentTime = 0; go.play().catch(() => {}); }
          if (s.score > s.highScore) {
            s.highScore = s.score;
            try { localStorage.setItem('sporinkaHighScore', String(s.score)); } catch { /* */ }
          }
          // Record this run in the ranking
          const name = (playerNameRef.current.trim() || 'ぼうけんしゃ').slice(0, 10);
          const { list, index } = insertRanking({ name, score: s.score, maxLevel: s.maxLevel });
          rankingRef.current = list;
          lastRankIdxRef.current = index;
          viewingRef.current = false;
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
      if (s.phase === 'gameover') {
        if (viewingRef.current) drawBoardView(ctx); // gaze at the final board
        else drawGameOver(ctx, s);
      }

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [drawBG, drawWalls, drawCeiling, drawMonster, drawHUD, drawGameOver, drawBoardView, drawPopups, drawSecretFx, handleMerge]);

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
      // Unlock BGM on first interaction (browser autoplay policy)
      if (bgmRef.current && bgmRef.current.paused && bgmOnRef.current) {
        bgmRef.current.play().catch(() => {});
      }
      if (modalRef.current !== null) return;
      if (inBtn(MENU_START_BTN)) {
        cancelAnimationFrame(rafRef.current);
        await initGame();
      } else if (inBtn(MENU_RANK_BTN)) {
        modalRef.current = 'ranking'; setModal('ranking');
      } else if (inBtn(MENU_SET_BTN)) {
        modalRef.current = 'settings'; setModal('settings');
      } else if (inBtn(MENU_HOW_BTN)) {
        modalRef.current = 'howto'; setModal('howto');
      }
    } else if (st.phase === 'gameover') {
      if (viewingRef.current) {
        // gazing at the final board
        if (inBtn(GO_BACK_BTN)) viewingRef.current = false;
        else if (inBtn(GO_VSHOT_BTN)) saveScreenshot();
      } else if (inBtn(GO_BTN)) {
        cancelAnimationFrame(rafRef.current);
        await initGame();
      } else if (inBtn(GO_VIEW_BTN)) {
        viewingRef.current = true;
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
        {modal !== null && (() => {
          const closeModal = () => { modalRef.current = null; setModal(null); };
          const panelStyle: React.CSSProperties = {
            background: 'rgba(8,8,28,0.98)',
            border: '1.5px solid #c8a030',
            borderRadius: 12,
            width: 360,
            maxHeight: 580,
            overflowY: 'auto',
            padding: '18px 22px 22px',
            boxSizing: 'border-box',
            color: '#f0e0b0',
            fontFamily: '"Noto Sans JP", sans-serif',
          };
          const h2Style: React.CSSProperties = {
            textAlign: 'center', color: '#c8a030', margin: '0 0 14px',
            fontSize: 16, fontWeight: 'bold',
          };
          const closeBtn: React.CSSProperties = {
            display: 'block', margin: '18px auto 0',
            padding: '8px 36px',
            background: 'rgba(10,10,30,0.9)',
            border: '1.5px solid #c8a030',
            borderRadius: 8,
            color: '#f0e0b0', fontSize: 13, cursor: 'pointer',
            fontFamily: '"Noto Sans JP", sans-serif',
          };
          const onStyle: React.CSSProperties = {
            padding: '6px 22px',
            background: 'linear-gradient(180deg,#3a2a00,#c8a030,#3a2a00)',
            border: '1.5px solid #ffe050', borderRadius: 7,
            color: '#fffadc', fontSize: 13, cursor: 'pointer',
            fontFamily: '"Noto Sans JP", sans-serif',
          };
          const offStyle: React.CSSProperties = {
            padding: '6px 22px',
            background: 'rgba(10,10,28,0.9)',
            border: '1.5px solid #3a3a60', borderRadius: 7,
            color: '#6a6a90', fontSize: 13, cursor: 'pointer',
            fontFamily: '"Noto Sans JP", sans-serif',
          };

          return (
            <div
              style={{
                position: 'absolute', top: 0, left: 0, width: W, height: H,
                background: 'rgba(4,4,20,0.88)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 10,
              }}
              onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
            >
              <div style={panelStyle}>
                {modal === 'ranking' && (<>
                  <h2 style={h2Style}>🏆 ランキング TOP10</h2>
                  {rankingRef.current.length === 0 ? (
                    <p style={{ textAlign: 'center', color: '#8a7a50', fontSize: 12 }}>
                      まだ記録がありません
                    </p>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <tbody>
                        {rankingRef.current.slice(0, 10).map((e, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid rgba(200,160,48,0.18)' }}>
                            <td style={{
                              padding: '7px 4px', width: 28, fontSize: 14, fontWeight: 'bold',
                              color: i === 0 ? '#ffd24a' : i === 1 ? '#cfd4dd' : i === 2 ? '#d8945a' : '#6a6a90',
                            }}>{i + 1}</td>
                            <td style={{ padding: '7px 4px' }}>
                              {e.name.length > 8 ? e.name.slice(0, 8) + '…' : e.name}
                            </td>
                            <td style={{ padding: '7px 4px', textAlign: 'right', color: '#ffe050', fontWeight: 'bold' }}>
                              {e.score}
                            </td>
                            <td style={{ padding: '7px 4px', textAlign: 'right', color: '#6a6a90', fontSize: 10 }}>
                              {evoName(e.maxLevel)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <button style={closeBtn} onClick={closeModal}>閉じる</button>
                </>)}

                {modal === 'settings' && (<>
                  <h2 style={h2Style}>⚙ セッティング</h2>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
                    <span style={{ fontSize: 14 }}>BGM</span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button style={bgmOn ? onStyle : offStyle} onClick={() => setBgmOn(true)}>ON</button>
                      <button style={!bgmOn ? onStyle : offStyle} onClick={() => setBgmOn(false)}>OFF</button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
                    <span style={{ fontSize: 14 }}>SE（効果音）</span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button style={seOn ? onStyle : offStyle} onClick={() => setSeOn(true)}>ON</button>
                      <button style={!seOn ? onStyle : offStyle} onClick={() => setSeOn(false)}>OFF</button>
                    </div>
                  </div>
                  <button style={closeBtn} onClick={closeModal}>閉じる</button>
                </>)}

                {modal === 'howto' && (<>
                  <h2 style={h2Style}>📖 遊び方</h2>
                  <ol style={{ paddingLeft: 20, margin: '0 0 16px', fontSize: 12, lineHeight: '2' }}>
                    <li>画面をクリック / タップしてモンスターを落とそう</li>
                    <li>同じモンスターが2体ぶつかると合成！次の進化形に変わる</li>
                    <li>モンスターが赤いラインを超えたまま止まると<span style={{ color: '#ff6060' }}>ゲームオーバー</span></li>
                    <li>短い間隔で合成を重ねると<span style={{ color: '#ffe050' }}>コンボボーナス</span>！</li>
                    <li>最強モンスターを2体合成すると<span style={{ color: '#ff9050' }}>消滅 +2000pt</span>！</li>
                  </ol>
                  <div style={{ borderTop: '1px solid rgba(200,160,48,0.35)', paddingTop: 14 }}>
                    <div style={{ color: '#c8a030', fontWeight: 'bold', marginBottom: 10, fontSize: 13 }}>
                      ✦ 進化ルート ✦
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px 3px', alignItems: 'center', fontSize: 11 }}>
                      {MONSTERS.slice(0, MAX_LEVEL).map((m, i) => (
                        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <span style={{
                            background: 'rgba(200,160,48,0.13)',
                            border: '1px solid rgba(200,160,48,0.45)',
                            borderRadius: 5, padding: '2px 6px',
                          }}>{m.name}</span>
                          <span style={{ color: '#c8a030' }}>→</span>
                        </span>
                      ))}
                      <span style={{
                        background: 'rgba(150,70,255,0.15)',
                        border: '1px solid rgba(150,70,255,0.5)',
                        borderRadius: 5, padding: '2px 6px', color: '#d0b0ff',
                      }}>？？？（消滅 +2000pt）</span>
                    </div>
                  </div>
                  <button style={closeBtn} onClick={closeModal}>閉じる</button>
                </>)}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
