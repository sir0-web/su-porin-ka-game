// Shared, framework-agnostic drawing + sprite helpers.
// Extracted from Game.tsx so both the solo game and the battle mode can
// reuse the exact same monster sprite processing / canvas primitives.

// ─── Rounded rect path ────────────────────────────────────────
export function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
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
export function hexA(hex: string, a: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ─── Processed (background-removed) sprite ────────────────────
export interface Sprite {
  canvas: HTMLCanvasElement;
  bx: number; by: number; bw: number; bh: number; // opaque bounding box
  circles: { dx: number; dy: number; r: number }[]; // collision circles, offset from centroid (sprite px)
  cxh: number; cyh: number;                          // centroid (render + body alignment)
}

interface Circle { x: number; y: number; r: number; }

// Approximate the visible silhouette with a few inscribed circles
// (greedy max-inscribed-circle packing on a distance transform).
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

// Keep only the largest opaque connected component.
function keepLargestComponent(d: Uint8ClampedArray, w: number, h: number) {
  const lbl = new Int32Array(w * h).fill(-1);
  let best = -1, bestArea = 0;
  for (let s = 0; s < w * h; s++) {
    if (d[s * 4 + 3] < 40 || lbl[s] !== -1) continue;
    const labelId = s;
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

export interface SpriteOpts { keepLargest?: boolean; erase?: [number, number, number][]; }

export function buildSprite(img: HTMLImageElement, opts: SpriteOpts = {}): Sprite | null {
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
  const CREAM2 = 54 * 54;
  const CHROMA = 32;
  const BRIGHT = 168;
  const isBg = (o: number): boolean => {
    if (d[o + 3] < 16) return true;
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

  const packed = packCircles(d, w, h, 12);
  let cx0 = (minx + maxx + 2) / 2, cy0 = (miny + maxy + 2) / 2;
  if (packed.length) {
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
