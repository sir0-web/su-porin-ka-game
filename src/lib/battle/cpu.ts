// CPU controller that drives a LocalBoard. 5 difficulty levels affect
// reaction speed, placement accuracy and how aggressively it aims for
// merges. Called every frame via think(); it throttles itself.
import { MONSTERS } from '@/lib/monsters';
import { B_GL, B_GR, type CpuLevel } from './types';
import type { LocalBoard } from './board';

interface Tuning {
  interval: [number, number]; // ms between drops [min,max]
  accuracy: number;           // 0..1 how often it makes the smart move
  jitter: number;             // px aim noise
}

const TUNE: Record<CpuLevel, Tuning> = {
  1: { interval: [1500, 2600], accuracy: 0.25, jitter: 60 },
  2: { interval: [1200, 2100], accuracy: 0.45, jitter: 42 },
  3: { interval: [950, 1700], accuracy: 0.65, jitter: 28 },
  4: { interval: [700, 1300], accuracy: 0.82, jitter: 16 },
  5: { interval: [520, 950], accuracy: 0.95, jitter: 8 },
};

export class CpuController {
  board: LocalBoard;
  t: Tuning;
  private nextDropAt = 0;
  private targetX: number;
  private rng: () => number;

  constructor(board: LocalBoard, level: CpuLevel, seed = Date.now()) {
    this.board = board;
    this.t = TUNE[level];
    this.rng = () => Math.random();
    void seed;
    this.targetX = (B_GL + B_GR) / 2;
    this.scheduleNext(800);
  }

  private scheduleNext(extra = 0) {
    const [lo, hi] = this.t.interval;
    this.nextDropAt = Date.now() + extra + lo + this.rng() * (hi - lo);
  }

  private chooseTarget() {
    const b = this.board;
    const cur = b.currentLevel;
    const monsters = b.listMonsters();

    // Smart move: aim above a resting same-level block to trigger a merge.
    const smart = this.rng() < this.t.accuracy;
    if (smart) {
      const sameLevel = monsters.filter((m) => m.level === cur);
      if (sameLevel.length) {
        // prefer the highest (lowest y is risky) — pick a mid one
        sameLevel.sort((a, b2) => b2.y - a.y); // lower on board first (safer)
        const pick = sameLevel[Math.floor(this.rng() * Math.min(2, sameLevel.length))];
        this.targetX = pick.x + (this.rng() - 0.5) * this.t.jitter;
        return;
      }
      // else: drop into the emptiest column (avoid stacking high)
      const cols = 6;
      const colW = (B_GR - B_GL) / cols;
      const height = new Array(cols).fill(0);
      for (const m of monsters) {
        const ci = Math.max(0, Math.min(cols - 1, Math.floor((m.x - B_GL) / colW)));
        height[ci] = Math.max(height[ci], 999 - m.y);
      }
      let best = 0;
      for (let i = 1; i < cols; i++) if (height[i] < height[best]) best = i;
      this.targetX = B_GL + colW * (best + 0.5) + (this.rng() - 0.5) * this.t.jitter;
      return;
    }
    // Random-ish move
    const r = MONSTERS[cur].radius;
    this.targetX = B_GL + r + this.rng() * (B_GR - B_GL - 2 * r);
  }

  think() {
    const b = this.board;
    if (b.dead) return;
    const now = Date.now();
    // Smoothly move the aim toward target every frame.
    const dx = this.targetX - b.dropX;
    b.moveTo(b.dropX + dx * 0.18);
    if (now >= this.nextDropAt && b.canDrop) {
      this.chooseTarget();
      // only drop once roughly aligned
      if (Math.abs(this.targetX - b.dropX) < 24) {
        b.drop();
        this.scheduleNext();
      }
    }
  }
}
