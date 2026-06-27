// Shared monster + ore drawing (used by the battle mode; the solo game
// keeps its own copy). Pure canvas functions — no React.
import { MONSTERS, MAX_LEVEL } from '@/lib/monsters';
import { hexA, type Sprite } from '@/lib/sprites';

export interface DrawOpts {
  alpha?: number;
  angle?: number;
  squash?: number;  // world-vertical squash (+ = flatter/wider)
  scale?: number;   // extra uniform scale (for mini-boards)
  lite?: boolean;   // skip halos/shadows for opponent boards (mobile perf)
}

export function drawMonster(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  level: number,
  procMap: Map<number, Sprite>,
  opts: DrawOpts = {},
) {
  const { alpha = 1, angle = 0, squash = 0, lite = false } = opts;
  const m = MONSTERS[level];
  const r = m.radius;
  const proc = procMap.get(level);

  ctx.save();
  ctx.globalAlpha = alpha;

  if (proc) {
    if (!lite) {
      const halo = ctx.createRadialGradient(x, y, r * 0.52, x, y, r * 1.2);
      halo.addColorStop(0, hexA(m.glowColor, 0.42));
      halo.addColorStop(0.62, hexA(m.glowColor, 0.16));
      halo.addColorStop(1, hexA(m.glowColor, 0));
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
    const s = (2 * r) / Math.min(proc.bw, proc.bh) * 1.05;
    const dw = proc.canvas.width * s;
    const dh = proc.canvas.height * s;
    const bcx = proc.cxh * s;
    const bcy = proc.cyh * s;
    ctx.translate(x, y);
    if (squash) ctx.scale(1 + squash, 1 - squash);
    ctx.rotate(angle);
    ctx.drawImage(proc.canvas, -bcx, -bcy, dw, dh);
  } else {
    // Fallback: gradient + kanji
    if (!lite) {
      ctx.shadowColor = m.glowColor;
      ctx.shadowBlur = r * 0.6;
      const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.08, x, y, r);
      g.addColorStop(0, m.highlightColor);
      g.addColorStop(0.55, m.color);
      g.addColorStop(1, m.shadowColor);
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = m.color;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (!lite) {
      ctx.shadowBlur = 0;
      ctx.strokeStyle = m.borderColor;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.shadowColor = m.iconGlow;
      ctx.shadowBlur = 10;
      ctx.fillStyle = m.iconColor;
      const fs = Math.max(9, Math.floor(r * 0.58));
      ctx.font = `bold ${fs}px "Noto Serif JP", "Yu Mincho", serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(m.icon, x, y + 1);
    }
  }
  ctx.restore();
}

// Procedural ore / gem crystal (no image asset required). Drawn as a
// faceted purple-gold crystal so it reads as "鉱石" on any board.
export function drawOre(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, seed = 0, opts: { lite?: boolean } = {}) {
  const { lite = false } = opts;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(((seed % 7) - 3) * 0.12);

  // glow
  if (!lite) {
    ctx.shadowColor = 'rgba(150,90,255,0.8)';
    ctx.shadowBlur = r * 0.9;
  }

  // hexagonal crystal body
  const facets = 6;
  ctx.beginPath();
  for (let i = 0; i < facets; i++) {
    const a = (Math.PI * 2 * i) / facets - Math.PI / 2;
    const rr = r * (i % 2 === 0 ? 1 : 0.82);
    const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  const g = ctx.createLinearGradient(-r, -r, r, r);
  g.addColorStop(0, '#d7b8ff');
  g.addColorStop(0.45, '#8a4ad8');
  g.addColorStop(1, '#3a1670');
  ctx.fillStyle = g;
  ctx.fill();
  if (!lite) ctx.shadowBlur = 0;

  // bright facet highlight
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.5, -r * 0.1);
  ctx.lineTo(0, r * 0.18);
  ctx.lineTo(-r * 0.5, -r * 0.1);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fill();

  // outline
  ctx.strokeStyle = '#e8d24a';
  ctx.lineWidth = Math.max(1, r * 0.1);
  ctx.beginPath();
  for (let i = 0; i < facets; i++) {
    const a = (Math.PI * 2 * i) / facets - Math.PI / 2;
    const rr = r * (i % 2 === 0 ? 1 : 0.82);
    const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();

  ctx.restore();
}

export function evoName(level: number): string {
  return level >= MAX_LEVEL ? '？？？' : MONSTERS[level].name;
}
