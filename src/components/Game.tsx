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
}

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
}

// Remove the light cream background AND the grey ground-shadow by
// flood-filling from the borders inward. A pixel counts as
// background when it is close to the cream colour, OR it is
// low-chroma and bright (the soft grey drop-shadow). The
// character's dark, saturated outline acts as a natural wall, so
// the body and its interior highlights are preserved. The alpha
// channel is then lightly blurred for a soft, feathered edge.
function buildSprite(img: HTMLImageElement): Sprite | null {
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

  return { canvas: c, bx: minx, by: miny, bw: maxx - minx + 1, bh: maxy - miny + 1 };
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

  const gs = useRef<GS>({
    phase: 'start',
    score: 0,
    highScore: 0,
    currentLevel: 0,
    nextLevel: 1,
    dropX: CX,
    canDrop: false,
    gameOverFrames: 0,
  });

  const [, forceRender] = useState(0);

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
      //    物理ボディの角度で回転（転がる動き）
      const s   = (2 * r) / Math.min(proc.bw, proc.bh) * 1.05;
      const dw  = proc.canvas.width  * s;
      const dh  = proc.canvas.height * s;
      const bcx = (proc.bx + proc.bw / 2) * s;
      const bcy = (proc.by + proc.bh / 2) * s;
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

    ctx.fillStyle = P.textDim;
    ctx.font = '7px "Noto Sans JP", sans-serif';
    ctx.textBaseline = 'bottom';
    const nameShort = nm.name.length > 7 ? nm.name.slice(0, 6) + '…' : nm.name;
    ctx.fillText(nameShort, nx + nw / 2, py + ph - 4);

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

  // ── Start screen ────────────────────────────────────────────
  const drawStart = useCallback((ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = 'rgba(4,4,20,0.88)';
    ctx.fillRect(0, 0, W, H);

    const bx = 40, by = 130, bw = W - 80, bh = 190;
    ctx.fillStyle = P.panel;
    rrect(ctx, bx, by, bw, bh, 10); ctx.fill();
    ctx.strokeStyle = P.gold; ctx.lineWidth = 2;
    rrect(ctx, bx, by, bw, bh, 10); ctx.stroke();

    diamond(ctx, bx,      by,      7);
    diamond(ctx, bx + bw, by,      7);
    diamond(ctx, bx,      by + bh, 7);
    diamond(ctx, bx + bw, by + bh, 7);

    ctx.textAlign = 'center';
    ctx.fillStyle = P.gold;
    ctx.font = 'bold 11px "Noto Sans JP", serif';
    ctx.textBaseline = 'top';
    ctx.fillText('～ Ragnarok Origin ～', CX, by + 16);

    ctx.shadowColor = P.goldBrt; ctx.shadowBlur = 20;
    ctx.fillStyle = P.goldBrt;
    ctx.font = 'bold 24px "Noto Serif JP", "Yu Mincho", serif';
    ctx.fillText('スぽりんカゲーム', CX, by + 44);
    ctx.shadowBlur = 0;

    ctx.strokeStyle = P.gold; ctx.lineWidth = 1; ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.moveTo(bx+20, by+82); ctx.lineTo(bx+bw-20, by+82); ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = P.text;
    ctx.font = '11px "Noto Sans JP", sans-serif';
    ctx.fillText('同じモンスターを合体させて', CX, by + 94);
    ctx.fillText('より強いモンスターへ進化させよう！', CX, by + 112);
    ctx.fillStyle = P.textDim;
    ctx.font = '10px "Noto Sans JP", sans-serif';
    ctx.fillText('天井ラインを超えるとゲームオーバー', CX, by + 134);
    ctx.fillText('「知らない人」同士が合体 → 消滅＆高得点！', CX, by + 152);

    // Start button
    const btnY = by + bh + 24, btnW = 180, btnH = 46, btnX = CX - btnW / 2;
    const bg = ctx.createLinearGradient(btnX, btnY, btnX, btnY + btnH);
    bg.addColorStop(0, '#3a2a00'); bg.addColorStop(0.5, '#c8a030'); bg.addColorStop(1, '#3a2a00');
    ctx.fillStyle = bg;
    rrect(ctx, btnX, btnY, btnW, btnH, 8); ctx.fill();
    ctx.strokeStyle = P.goldBrt; ctx.lineWidth = 1.5;
    rrect(ctx, btnX, btnY, btnW, btnH, 8); ctx.stroke();
    ctx.shadowColor = P.goldBrt; ctx.shadowBlur = 12;
    ctx.fillStyle = '#fffadc';
    ctx.font = 'bold 15px "Noto Sans JP", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚔  ゲームスタート  ⚔', CX, btnY + btnH / 2);
    ctx.shadowBlur = 0;

    // Mini evolution preview
    const preY = by + bh + 86;
    ctx.fillStyle = P.textDim;
    ctx.font = '9px "Noto Sans JP", sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('— 進化ルート —', CX, preY);
    const shown = [0, 1, 2, 4, 6, 8, 10];
    shown.forEach((lvl, i) => {
      const px = 26 + i * 50;
      const pr = Math.min(MONSTERS[lvl].radius, 17);
      const sc = pr / MONSTERS[lvl].radius;
      ctx.save();
      ctx.translate(px, preY + 30);
      ctx.scale(sc, sc);
      drawMonster(ctx, 0, 0, lvl, 0.9);
      ctx.restore();
      if (i < shown.length - 1) {
        ctx.fillStyle = P.gold;
        ctx.font = 'bold 10px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText('›', px + 24, preY + 30);
      }
    });
  }, [diamond, drawMonster]);

  // ── Game over screen ────────────────────────────────────────
  const drawGameOver = useCallback((ctx: CanvasRenderingContext2D, st: GS) => {
    ctx.fillStyle = 'rgba(4,4,20,0.88)';
    ctx.fillRect(0, 0, W, H);

    const bx = 50, by = 170, bw = W - 100, bh = 240;
    ctx.fillStyle = P.panel;
    rrect(ctx, bx, by, bw, bh, 10); ctx.fill();
    ctx.strokeStyle = '#800000'; ctx.lineWidth = 2;
    rrect(ctx, bx, by, bw, bh, 10); ctx.stroke();

    diamond(ctx, bx,      by,      7);
    diamond(ctx, bx + bw, by,      7);
    diamond(ctx, bx,      by + bh, 7);
    diamond(ctx, bx + bw, by + bh, 7);

    ctx.textAlign = 'center';
    ctx.shadowColor = '#ff0000'; ctx.shadowBlur = 18;
    ctx.fillStyle = '#ff5050';
    ctx.font = 'bold 28px "Noto Serif JP", serif';
    ctx.textBaseline = 'top';
    ctx.fillText('GAME OVER', CX, by + 20);
    ctx.shadowBlur = 0;

    ctx.strokeStyle = P.gold; ctx.lineWidth = 1; ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.moveTo(bx+20, by+66); ctx.lineTo(bx+bw-20, by+66); ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = P.text;
    ctx.font = '11px "Noto Sans JP", sans-serif';
    ctx.fillText('スコア', CX, by + 82);

    ctx.shadowColor = P.goldBrt; ctx.shadowBlur = 10;
    ctx.fillStyle = P.goldBrt;
    ctx.font = 'bold 40px "Oswald", "Arial Narrow", sans-serif';
    ctx.fillText(String(st.score), CX, by + 100);
    ctx.shadowBlur = 0;

    const isNew = st.score > 0 && st.score >= st.highScore;
    ctx.fillStyle = isNew ? '#ff9050' : P.gold;
    ctx.font = isNew ? 'bold 11px "Noto Sans JP"' : '10px "Noto Sans JP"';
    ctx.fillText(isNew ? '🎉  NEW RECORD!  🎉' : `ベスト: ${st.highScore}`, CX, by + 160);

    // Evolution progress display
    ctx.fillStyle = P.textDim;
    ctx.font = '9px "Noto Sans JP", sans-serif';
    ctx.fillText('最大進化: ' + MONSTERS[Math.min(st.score > 0 ? 10 : 0, MAX_LEVEL)].name, CX, by + 185);

    // Retry button
    const btnY = by + bh + 18, btnW = 180, btnH = 46, btnX = CX - btnW / 2;
    const bg = ctx.createLinearGradient(btnX, btnY, btnX, btnY + btnH);
    bg.addColorStop(0, '#1a0030'); bg.addColorStop(0.5, '#6030c0'); bg.addColorStop(1, '#1a0030');
    ctx.fillStyle = bg;
    rrect(ctx, btnX, btnY, btnW, btnH, 8); ctx.fill();
    ctx.strokeStyle = '#a060ff'; ctx.lineWidth = 1.5;
    rrect(ctx, btnX, btnY, btnW, btnH, 8); ctx.stroke();
    ctx.fillStyle = '#f0e0ff';
    ctx.font = 'bold 15px "Noto Sans JP", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚔  もう一度挑戦  ⚔', CX, btnY + btnH / 2);
  }, [diamond]);

  // ── Spawn a monster body ────────────────────────────────────
  const spawnMonster = useCallback((
    Matter: typeof import('matter-js'),
    x: number, y: number,
    level: number,
  ) => {
    const engine = engineRef.current as import('matter-js').Engine;
    const m = MONSTERS[level];
    const body = Matter.Bodies.circle(x, y, m.radius, {
      restitution: 0.28,
      friction: 0.45,
      frictionStatic: 0.6,
      frictionAir: 0.006,
      density: 0.002,
      label: `monster_${level}`,
    });
    bodyDataRef.current.set(body.id, { monsterId: level, createdAt: Date.now(), isMerging: false });
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

      if (level === MAX_LEVEL) {
        gs.current.score += SPECIAL_MERGE_SCORE;
      } else {
        const nextLevel = level + 1;
        const newBody = spawnMonster(Matter, mx, Math.max(my, CEILING_Y + MONSTERS[nextLevel].radius), nextLevel);
        Matter.Body.setVelocity(newBody, {
          x: (bodyA.velocity.x + bodyB.velocity.x) * 0.3,
          y: -2.5,
        });
        Matter.Body.setAngularVelocity(newBody, (bodyA.angle - bodyB.angle) * 0.1 + (Math.random() - 0.5) * 0.1);
        gs.current.score += MONSTERS[nextLevel].score;
      }

      const s = gs.current;
      if (s.score > s.highScore) {
        s.highScore = s.score;
        try { localStorage.setItem('sporinkaHighScore', String(s.score)); } catch { /* */ }
      }
    }, 80);
  }, [spawnMonster]);

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
    // slight initial spin so it tumbles naturally on landing
    Matter.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.12);

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
    st.phase          = 'playing';
    coolRef.current   = 0;

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

    forceRender(n => n + 1);

    let last = 0;
    const loop = (ts: number) => {
      const dt = Math.min(ts - last, 33);
      last = ts;
      Matter.Engine.update(engine, dt > 0 ? dt : 16);

      const s = gs.current;

      // Game over detection: settled body above ceiling
      if (s.phase === 'playing') {
        const bodies = Matter.Composite.allBodies(engine.world);
        let danger = false;
        for (const b of bodies) {
          if (b.isStatic) continue;
          const d = bodyDataRef.current.get(b.id);
          if (!d || d.isMerging) continue;
          if (Date.now() - d.createdAt < 1200) continue;
          const speed = Math.hypot(b.velocity.x, b.velocity.y);
          const top   = b.position.y - MONSTERS[d.monsterId].radius;
          if (speed < 2.0 && top < CEILING_Y) { danger = true; break; }
        }
        s.gameOverFrames = danger ? s.gameOverFrames + 1 : 0;
        if (s.gameOverFrames > 80) {
          s.phase = 'gameover';
          if (s.score > s.highScore) {
            s.highScore = s.score;
            try { localStorage.setItem('sporinkaHighScore', String(s.score)); } catch { /* */ }
          }
          forceRender(n => n + 1);
        }
      }

      // Render
      ctx.clearRect(0, 0, W, H);
      drawBG(ctx);
      drawWalls(ctx);
      drawCeiling(ctx);

      const allBodies = Matter.Composite.allBodies(engine.world);
      for (const b of allBodies) {
        if (b.isStatic) continue;
        const d = bodyDataRef.current.get(b.id);
        if (!d) continue;
        drawMonster(ctx, b.position.x, b.position.y, d.monsterId, d.isMerging ? 0.5 : 1, b.angle);
      }

      drawHUD(ctx, s);
      if (s.phase === 'gameover') drawGameOver(ctx, s);

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [drawBG, drawWalls, drawCeiling, drawMonster, drawHUD, drawGameOver, handleMerge]);

  // ── Preload + preprocess monster images ─────────────────────
  useEffect(() => {
    MONSTERS.forEach((m) => {
      const img = new Image();
      img.onload = () => {
        try {
          const sp = buildSprite(img);
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
      const avail = (wrap.parentElement?.clientWidth ?? window.innerWidth) - 16;
      const s = Math.min(1, avail / W);
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

    if (st.phase === 'start') {
      const btnW = 180, btnH = 46, btnX = CX - 90;
      const btnY = 130 + 190 + 24;
      if (cx >= btnX && cx <= btnX + btnW && cy >= btnY && cy <= btnY + btnH) {
        cancelAnimationFrame(rafRef.current);
        await initGame();
      }
    } else if (st.phase === 'gameover') {
      const btnW = 180, btnH = 46, btnX = CX - 90;
      const btnY = 170 + 240 + 18;
      if (cx >= btnX && cx <= btnX + btnW && cy >= btnY && cy <= btnY + btnH) {
        cancelAnimationFrame(rafRef.current);
        await initGame();
      }
    } else {
      drop();
    }
  }, [initGame, drop]);

  return (
    <div ref={wrapRef} style={{ display: 'flex', justifyContent: 'center' }}>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        style={{ display: 'block', cursor: 'crosshair', touchAction: 'none' }}
        onClick={(e) => handleClick(e.clientX, e.clientY)}
        onTouchEnd={(e) => {
          e.preventDefault();
          const t = e.changedTouches[0];
          gs.current.dropX = Math.max(GL+5, Math.min(GR-5,
            (t.clientX - (canvasRef.current?.getBoundingClientRect().left ?? 0)) / scaleRef.current
          ));
          handleClick(t.clientX, t.clientY);
        }}
      />
    </div>
  );
}
