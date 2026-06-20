// A single self-contained Suika board simulation (one player). Used for
// the local human board AND for any CPU boards the room host simulates.
// Remote players' boards are NOT simulated — they are drawn from snapshots.
import { MONSTERS, getRandomStartLevel, MAX_LEVEL, SPECIAL_MERGE_SCORE } from '@/lib/monsters';
import {
  B_GL, B_GR, B_CX, B_FLOOR_Y, B_CEILING_Y, B_DROP_Y, B_WALL, B_H,
  DROP_COOLDOWN, ORE_BY_LEVEL, ORE_SPECIAL_MERGE,
  type SnapshotMsg,
} from './types';
import type { Sprite } from '@/lib/sprites';

type Matter = typeof import('matter-js');
type MEngine = import('matter-js').Engine;
type MBody = import('matter-js').Body;

const ORE_R = 13;
const AUTO_ORE_MS = 3500; // pending ore auto-drops after this long without a player drop

interface BData {
  level: number;       // monster level, or -1 for ore
  createdAt: number;
  isMerging: boolean;
  squashT?: number;
  squashAmp?: number;
}

export interface MergeFx { x: number; y: number; level: number; big: boolean; }

export interface BoardCallbacks {
  // emit an attack of `count` ore (host routes it to a random opponent)
  onAttack?: (count: number) => void;
  // merge happened (for local FX): produced `level`
  onMerge?: (fx: MergeFx) => void;
  onDead?: () => void;
}

export class LocalBoard {
  M: Matter;
  engine: MEngine;
  data = new Map<number, BData>();
  merging = new Set<number>();
  proc: Map<number, Sprite>;
  cb: BoardCallbacks;

  currentLevel: number;
  nextLevel: number;
  dropX = B_CX;
  canDrop = true;
  coolUntil = 0;
  pendingOre = 0;     // ore waiting to drop on next turn
  pendingSince = 0;   // when the current pending batch first arrived (ms)
  score = 0;
  maxLevel = 0;
  dead = false;
  place = 0;
  private gameOverFrames = 0;
  private overLineFrames = 0;
  private rng: () => number;

  constructor(M: Matter, proc: Map<number, Sprite>, cb: BoardCallbacks, seed = Date.now()) {
    this.M = M;
    this.proc = proc;
    this.cb = cb;
    this.rng = mulberry32(seed >>> 0);
    this.currentLevel = getRandomStartLevel();
    this.nextLevel = getRandomStartLevel();
    this.maxLevel = this.currentLevel;

    const engine = M.Engine.create({ gravity: { x: 0, y: 1.8 } });
    this.engine = engine;
    const ground = M.Bodies.rectangle(B_CX, B_FLOOR_Y + 40, BWpad(), 80, { isStatic: true, label: 'ground', friction: 0.6 });
    const leftW = M.Bodies.rectangle(B_GL / 2, B_H / 2, B_WALL + 2, B_H * 2, { isStatic: true, label: 'wall', friction: 0.4 });
    const rightW = M.Bodies.rectangle(B_GR + B_WALL / 2, B_H / 2, B_WALL + 2, B_H * 2, { isStatic: true, label: 'wall', friction: 0.4 });
    M.Composite.add(engine.world, [ground, leftW, rightW]);

    M.Events.on(engine, 'collisionStart', (event: import('matter-js').IEventCollision<MEngine>) => {
      for (const pair of event.pairs) {
        const a = pair.bodyA.parent ?? pair.bodyA;
        const b = pair.bodyB.parent ?? pair.bodyB;
        if (!a.isStatic) this.squash(a);
        if (!b.isStatic) this.squash(b);
        if (pair.bodyA.isStatic || pair.bodyB.isStatic) continue;
        if (a === b) continue;
        this.tryMerge(a, b);
      }
    });
  }

  private squash(b: MBody) {
    const d = this.data.get(b.id);
    if (!d || d.isMerging) return;
    const speed = Math.hypot(b.velocity.x, b.velocity.y);
    if (speed < 4) return;
    const now = Date.now();
    if (d.squashT && now - d.squashT < 90) return;
    d.squashT = now;
    d.squashAmp = Math.min(0.24, 0.02 + speed * 0.011);
  }

  private spawnMonster(x: number, y: number, level: number): MBody {
    const M = this.M;
    const m = MONSTERS[level];
    const opts = {
      restitution: 0.15, friction: 0.4, frictionStatic: 0.55,
      frictionAir: 0.012, density: 0.002, label: `monster_${level}`,
    };
    let body: MBody | undefined;
    const sp = this.proc.get(level);
    if (sp && sp.circles.length >= 1) {
      const s = (2 * m.radius * 1.05) / Math.min(sp.bw, sp.bh);
      try {
        if (sp.circles.length === 1) {
          body = M.Bodies.circle(x, y, Math.max(2, sp.circles[0].r * s), opts);
        } else {
          const parts = sp.circles.map((c) =>
            M.Bodies.circle(x + c.dx * s, y + c.dy * s, Math.max(2, c.r * s), opts));
          body = M.Body.create({ parts, label: `monster_${level}`, frictionAir: 0.012 });
        }
      } catch { /* fall through */ }
    }
    if (!body) body = M.Bodies.circle(x, y, m.radius, opts);
    this.data.set(body.id, { level, createdAt: Date.now(), isMerging: false });
    if (level > this.maxLevel) this.maxLevel = level;
    M.Composite.add(this.engine.world, body);
    return body;
  }

  private spawnOre(x: number, y: number): MBody {
    const M = this.M;
    const body = M.Bodies.circle(x, y, ORE_R, {
      restitution: 0.1, friction: 0.5, frictionStatic: 0.7,
      frictionAir: 0.02, density: 0.0035, label: 'ore',
    });
    this.data.set(body.id, { level: -1, createdAt: Date.now(), isMerging: false });
    M.Composite.add(this.engine.world, body);
    return body;
  }

  private tryMerge(a: MBody, b: MBody) {
    const da = this.data.get(a.id);
    const db = this.data.get(b.id);
    if (!da || !db) return;
    if (da.level < 0 || db.level < 0) return;        // ore never merges
    if (da.level !== db.level) return;
    if (da.isMerging || db.isMerging) return;
    if (this.merging.has(a.id) || this.merging.has(b.id)) return;

    const level = da.level;
    this.merging.add(a.id); this.merging.add(b.id);
    da.isMerging = true; db.isMerging = true;
    const mx = (a.position.x + b.position.x) / 2;
    const my = (a.position.y + b.position.y) / 2;

    // Clear ore in contact with either merging body (ore touching a cleared block vanishes)
    this.clearTouchingOre(a, b, level);

    setTimeout(() => {
      const M = this.M;
      M.Composite.remove(this.engine.world, a);
      M.Composite.remove(this.engine.world, b);
      this.data.delete(a.id); this.data.delete(b.id);
      this.merging.delete(a.id); this.merging.delete(b.id);

      const base = level === MAX_LEVEL ? SPECIAL_MERGE_SCORE : MONSTERS[level + 1].score;
      this.score += base;

      if (level === MAX_LEVEL) {
        // special merge: both vanish; heavy attack
        this.cb.onAttack?.(ORE_SPECIAL_MERGE);
        this.cb.onMerge?.({ x: mx, y: my, level: MAX_LEVEL, big: true });
      } else {
        const nextLevel = level + 1;
        const nb = this.spawnMonster(mx, Math.max(my, B_CEILING_Y + MONSTERS[nextLevel].radius), nextLevel);
        M.Body.setVelocity(nb, { x: (a.velocity.x + b.velocity.x) * 0.3, y: -2.5 });
        M.Body.setAngularVelocity(nb, (Math.random() - 0.5) * 0.04);
        const ore = ORE_BY_LEVEL[nextLevel] ?? 0;
        if (ore > 0) this.cb.onAttack?.(ore);
        this.cb.onMerge?.({ x: mx, y: my, level: nextLevel, big: nextLevel >= 6 });
      }
    }, 80);
  }

  private clearTouchingOre(a: MBody, b: MBody, level: number) {
    const reach = MONSTERS[level].radius + ORE_R + 8;
    const toRemove: MBody[] = [];
    for (const body of this.M.Composite.allBodies(this.engine.world)) {
      const d = this.data.get(body.id);
      if (!d || d.level !== -1) continue;
      const da = Math.hypot(body.position.x - a.position.x, body.position.y - a.position.y);
      const dbb = Math.hypot(body.position.x - b.position.x, body.position.y - b.position.y);
      if (da < reach || dbb < reach) toRemove.push(body);
    }
    for (const o of toRemove) {
      this.M.Composite.remove(this.engine.world, o);
      this.data.delete(o.id);
    }
  }

  // Drop the current block at dropX. Returns true if a drop occurred.
  drop(): boolean {
    if (this.dead || !this.canDrop || Date.now() < this.coolUntil) return false;
    const r = MONSTERS[this.currentLevel].radius;
    const clX = Math.max(B_GL + r + 2, Math.min(B_GR - r - 2, this.dropX));
    const body = this.spawnMonster(clX, B_DROP_Y, this.currentLevel);
    this.M.Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.03);
    this.currentLevel = this.nextLevel;
    this.nextLevel = getRandomStartLevel();
    this.canDrop = false;
    this.coolUntil = Date.now() + DROP_COOLDOWN;
    setTimeout(() => { this.canDrop = true; }, DROP_COOLDOWN);

    // Release any pending ore that was queued from opponents' attacks.
    this.releasePendingOre();
    return true;
  }

  // Drop all queued ore into the field (spread across the top).
  private releasePendingOre() {
    if (this.pendingOre <= 0) return;
    const n = this.pendingOre;
    this.pendingOre = 0;
    this.pendingSince = 0;
    for (let i = 0; i < n; i++) {
      const ox = B_GL + ORE_R + 4 + this.rng() * (B_GR - B_GL - 2 * ORE_R - 8);
      setTimeout(() => { if (!this.dead) this.spawnOre(ox, B_DROP_Y - 10 - (i % 3) * 8); }, 120 + i * 70);
    }
  }

  receiveOre(count: number) {
    if (this.dead) return;
    if (this.pendingOre === 0) this.pendingSince = Date.now();
    this.pendingOre = Math.min(this.pendingOre + count, 24);
  }

  moveTo(x: number) {
    this.dropX = Math.max(B_GL + 5, Math.min(B_GR - 5, x));
  }

  // Advance physics + detect game over. Returns true on the frame death occurs.
  step(dt: number): boolean {
    if (this.dead) return false;
    const M = this.M;
    M.Engine.update(this.engine, dt > 0 ? Math.min(dt, 33) : 16);

    // Anti-stall: if ore has been waiting too long without the player
    // dropping, it falls on its own. Otherwise a player could survive by
    // never dropping (never releasing the ore sent to them).
    if (this.pendingOre > 0 && this.pendingSince > 0 && Date.now() - this.pendingSince > AUTO_ORE_MS) {
      this.releasePendingOre();
    }

    const MAXV = 32, MAXW = 0.5;
    for (const b of M.Composite.allBodies(this.engine.world)) {
      if (b.isStatic) continue;
      const sp = Math.hypot(b.velocity.x, b.velocity.y);
      if (sp > MAXV) M.Body.setVelocity(b, { x: (b.velocity.x / sp) * MAXV, y: (b.velocity.y / sp) * MAXV });
      if (b.angularVelocity > MAXW || b.angularVelocity < -MAXW) {
        M.Body.setAngularVelocity(b, Math.max(-MAXW, Math.min(MAXW, b.angularVelocity)));
      }
    }

    const bodies = M.Composite.allBodies(this.engine.world);
    const REST_V = 0.6, REST_W = 0.08;
    let allResting = true, anyOverLine = false;
    for (const b of bodies) {
      if (b.isStatic) continue;
      const d = this.data.get(b.id);
      if (!d || d.isMerging) continue;
      const speed = Math.hypot(b.velocity.x, b.velocity.y);
      if (speed > REST_V || Math.abs(b.angularVelocity) > REST_W) allResting = false;
      if (Date.now() - d.createdAt < 500) continue;
      const r = d.level < 0 ? ORE_R : MONSTERS[d.level].radius;
      if (b.position.y - r < B_CEILING_Y) anyOverLine = true;
    }
    if (allResting && anyOverLine) this.gameOverFrames++; else this.gameOverFrames = 0;
    if (anyOverLine) this.overLineFrames++; else this.overLineFrames = 0;
    if (this.gameOverFrames > 25 || this.overLineFrames > 200) {
      this.dead = true;
      this.cb.onDead?.();
      return true;
    }
    return false;
  }

  // For local FX: list bodies with positions & squash for rendering.
  forEachBody(fn: (level: number, x: number, y: number, angle: number, squash: number, merging: boolean) => void) {
    for (const b of this.M.Composite.allBodies(this.engine.world)) {
      if (b.isStatic) continue;
      const d = this.data.get(b.id);
      if (!d) continue;
      let sq = 0;
      if (d.squashT) {
        const el = (Date.now() - d.squashT) / 1000;
        const DUR = 0.34;
        if (el < DUR) sq = (d.squashAmp ?? 0) * Math.cos(el * 26) * (1 - el / DUR);
        else d.squashT = 0;
      }
      fn(d.level, b.position.x, b.position.y, b.angle, sq, d.isMerging);
    }
  }

  // Resting monsters (for CPU decision-making).
  listMonsters(): { level: number; x: number; y: number; r: number }[] {
    const out: { level: number; x: number; y: number; r: number }[] = [];
    for (const body of this.M.Composite.allBodies(this.engine.world)) {
      if (body.isStatic) continue;
      const d = this.data.get(body.id);
      if (!d || d.isMerging || d.level < 0) continue;
      out.push({ level: d.level, x: body.position.x, y: body.position.y, r: MONSTERS[d.level].radius });
    }
    return out;
  }

  serialize(id: string): SnapshotMsg {
    const b: number[] = [];
    const o: number[] = [];
    for (const body of this.M.Composite.allBodies(this.engine.world)) {
      if (body.isStatic) continue;
      const d = this.data.get(body.id);
      if (!d || d.isMerging) continue;
      if (d.level < 0) {
        o.push(Math.round(body.position.x), Math.round(body.position.y));
      } else {
        b.push(d.level, Math.round(body.position.x), Math.round(body.position.y), Math.round(body.angle * 100));
      }
    }
    return {
      id, b, o, pending: this.pendingOre,
      cur: this.currentLevel, next: this.nextLevel, dropX: Math.round(this.dropX),
      score: this.score, dead: this.dead, place: this.place,
    };
  }

  destroy() {
    try { this.M.Engine.clear(this.engine); } catch { /* */ }
    this.data.clear();
    this.merging.clear();
  }
}

function BWpad() { return B_GR - B_GL + 80; }

// Small deterministic PRNG so ore spawn positions can be reproducible.
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
