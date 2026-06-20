// ─── Battle-mode shared types & tuning ──────────────────────────
// The battle field reuses the solo play-field geometry (W=400 wide,
// the same walls / danger line) so the physics + sprites behave
// identically. Layout on screen (landscape, multi-board) is handled
// by the renderer.

export const MAX_PLAYERS = 4;

// Per-board play-field geometry (matches the solo game's interior).
export const BW = 400;          // board width
export const B_WALL = 14;
export const B_FLOOR_Y = 646;   // floor (blocks rest here)
export const B_CEILING_Y = 118; // danger line
export const B_DROP_Y = 68;
export const B_GL = B_WALL;
export const B_GR = BW - B_WALL;
export const B_CX = BW / 2;
export const B_H = 660;         // board height used for the battle field (no bottom HUD bar)

export const DROP_COOLDOWN = 500;

// How often each client broadcasts its board snapshot (ms).
export const SNAPSHOT_INTERVAL = 110;

// Lobby auto-start: if humans haven't all readied within this time after
// the owner could start, remaining empty/unready slots become CPU.
export const FORCE_CPU_MS = 60_000;

export type CpuLevel = 1 | 2 | 3 | 4 | 5;

export type SlotKind = 'human' | 'cpu' | 'empty';

export interface PlayerSlot {
  index: number;            // 0..3
  kind: SlotKind;
  id: string;               // client id (human) or `cpu_<index>`
  name: string;
  cpuLevel?: CpuLevel;
  ready: boolean;
  isOwner: boolean;
}

// Presence payload each human tracks about itself in the room channel.
export interface PresenceState {
  id: string;
  name: string;
  ready: boolean;
  joinedAt: number;
}

// Owner-authoritative room state broadcast to all members.
export interface RoomState {
  hostId: string;
  started: boolean;
  // CPU slots the owner has added: keyed by slot index.
  cpus: { index: number; level: CpuLevel; name: string }[];
  // Final slot ordering decided by the owner at start (ids in slot order).
  order?: string[];
  seed?: number;
}

// Global-lobby announcement (only owners announce their room).
export interface RoomAd {
  roomId: string;
  hostId: string;
  count: number;     // current human count
  started: boolean;
  updatedAt: number;
}

// ─── Realtime broadcast event payloads ──────────────────────────

// Compact board snapshot. Arrays are flat to keep messages small.
export interface SnapshotMsg {
  id: string;                 // sender player id
  // bodies: [level, x, y, angle] flattened
  b: number[];
  // ore bodies: [x, y] flattened
  o: number[];
  pending: number;            // ore waiting to drop next turn
  cur: number;                // current monster level at the dropper
  next: number;               // next monster level
  dropX: number;
  score: number;
  mc: number;                 // max combo achieved
  ml: number;                 // max evolution level reached
  dead: boolean;
  place: number;              // finishing place (0 = still alive)
}

export interface AttackMsg {
  from: string;
  to: string;
  count: number;              // ore count being sent
}

export interface StartMsg {
  seed: number;
  order: string[];            // player ids in slot order
}

export interface DeadMsg {
  id: string;
  place: number;
}

export type BattlePhase = 'orient' | 'lobby' | 'countdown' | 'playing' | 'result';

// ─── Ore attack tuning ──────────────────────────────────────────
// Ore sent when a merge PRODUCES a block of the given level.
// Bigger evolutions = heavier attacks. Index = produced level.
export const ORE_BY_LEVEL: number[] = [
  0, // 0 (never produced)
  0, // 1 (egg→poring, no attack)
  1, // 2
  1, // 3
  2, // 4
  2, // 5
  3, // 6
  4, // 7
  5, // 8
  6, // 9
  8, // 10 (知らない人 born)
];
// Special merge (two 知らない人 vanish) = big finisher attack.
export const ORE_SPECIAL_MERGE = 10;

// ─── 総合スコア（順位付けの基準）──────────────────────────────
// 放置（何もしない）では勝てないよう、合体スコア・連鎖・最大進化と
// いった「攻めた量」が支配的になるよう重み付けする。生存はボーナス
// 扱い（生き残ると加点だが、それだけでは上位に来ない）。
export const MATCH_DURATION_MS = 150_000; // 試合時間（全滅 or 時間切れで終了）
export const SC_COMBO = 300;              // 最大連鎖 1 あたり
export const SC_LEVEL = 1000;             // 最大進化 1 段あたり
export const SC_SURVIVE = 1500;           // 時間切れ時に生存していたボーナス

export function battleScore(score: number, maxCombo: number, maxLevel: number, alive: boolean): number {
  return Math.round(score + maxCombo * SC_COMBO + maxLevel * SC_LEVEL + (alive ? SC_SURVIVE : 0));
}

// Map a finishing place to a label.
export function placeLabel(place: number): string {
  return place === 1 ? '1位' : place === 2 ? '2位' : place === 3 ? '3位' : place === 4 ? '4位' : '—';
}

let _cid = '';
export function clientId(): string {
  if (_cid) return _cid;
  try {
    const k = 'suiga_client_id';
    const ex = localStorage.getItem(k);
    if (ex) { _cid = ex; return _cid; }
  } catch { /* */ }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 12; i++) s += chars[Math.floor(Math.random() * chars.length)];
  _cid = s;
  try { localStorage.setItem('suiga_client_id', s); } catch { /* */ }
  return _cid;
}
