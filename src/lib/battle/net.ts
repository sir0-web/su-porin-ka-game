// Realtime networking for the battle mode, built on Supabase Realtime
// (Presence + Broadcast). No database tables are required.
//
//   • Global lobby channel `suiga_lobby` — room OWNERS advertise their
//     open room (RoomAd) via presence so newcomers can find & join one.
//   • Per-room channel `suiga_room_<id>` — humans track PresenceState;
//     the owner broadcasts authoritative RoomState (CPU slots, start).
//     Gameplay messages (snapshot / attack / dead) are broadcast too.
//
// Everything degrades gracefully: when Supabase isn't configured the
// caller can run a fully offline CPU room instead.
import { getSupabaseBrowser } from '@/lib/supabaseClient';
import {
  clientId,
  type PresenceState, type RoomState, type RoomAd,
  type SnapshotMsg, type AttackMsg, type StartMsg, type DeadMsg,
  type CpuLevel, MAX_PLAYERS,
} from './types';
import type { RealtimeChannel } from '@supabase/supabase-js';

export interface NetCallbacks {
  onRoom?: (roomId: string, isOwner: boolean) => void;
  onLobby?: (humans: PresenceState[], room: RoomState) => void;
  onStart?: (msg: StartMsg) => void;
  onSnapshot?: (msg: SnapshotMsg) => void;
  onAttack?: (msg: AttackMsg) => void;
  onDead?: (msg: DeadMsg) => void;
  onError?: (reason: string) => void;
}

function randRoomId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export class BattleNet {
  id = clientId();
  name = '';
  roomId = '';
  isOwner = false;
  cb: NetCallbacks;

  private lobbyCh: RealtimeChannel | null = null;
  private roomCh: RealtimeChannel | null = null;
  private myReady = false;
  private joinedAt = Date.now();
  // owner-authoritative room state
  private room: RoomState = { hostId: this.id, started: false, cpus: [] };

  constructor(cb: NetCallbacks) { this.cb = cb; }

  get online(): boolean { return !!getSupabaseBrowser(); }

  // ── Matchmaking: find an open room or create one ──────────────
  async connect(name: string): Promise<{ roomId: string; isOwner: boolean } | null> {
    this.name = name;
    const sb = getSupabaseBrowser();
    if (!sb) { this.cb.onError?.('not-configured'); return null; }

    // 1. Subscribe to the global lobby and read advertised rooms.
    const lobby = sb.channel('suiga_lobby', { config: { presence: { key: this.id } } });
    this.lobbyCh = lobby;
    const ads = await new Promise<RoomAd[]>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return; settled = true;
        const state = lobby.presenceState() as Record<string, Array<Record<string, unknown>>>;
        const list: RoomAd[] = [];
        for (const key of Object.keys(state)) {
          const meta = state[key]?.[0] as unknown as RoomAd | undefined;
          if (meta && meta.roomId) list.push(meta);
        }
        resolve(list);
      };
      lobby.on('presence', { event: 'sync' }, () => { /* keep latest */ });
      lobby.subscribe((status) => {
        if (status === 'SUBSCRIBED') setTimeout(finish, 700);
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') resolve([]);
      });
    });

    const open = ads
      .filter((a) => !a.started && a.count < MAX_PLAYERS)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    if (open.length > 0) {
      this.roomId = open[0].roomId;
      this.isOwner = false;
    } else {
      this.roomId = randRoomId();
      this.isOwner = true;
      this.room = { hostId: this.id, started: false, cpus: [] };
    }

    await this.joinRoom();
    if (this.isOwner) await this.advertise();
    this.cb.onRoom?.(this.roomId, this.isOwner);
    return { roomId: this.roomId, isOwner: this.isOwner };
  }

  private async joinRoom() {
    const sb = getSupabaseBrowser();
    if (!sb) return;
    this.joinedAt = Date.now();
    const ch = sb.channel(`suiga_room_${this.roomId}`, {
      config: { presence: { key: this.id }, broadcast: { self: false } },
    });
    this.roomCh = ch;

    ch.on('presence', { event: 'sync' }, () => this.emitLobby());
    ch.on('broadcast', { event: 'roomstate' }, ({ payload }) => {
      if (!this.isOwner) { this.room = payload as RoomState; this.emitLobby(); }
    });
    ch.on('broadcast', { event: 'start' }, ({ payload }) => this.cb.onStart?.(payload as StartMsg));
    ch.on('broadcast', { event: 'snapshot' }, ({ payload }) => this.cb.onSnapshot?.(payload as SnapshotMsg));
    // Deliver ALL attacks; the component decides whether `to` is a board
    // it simulates (its own human board, or — for the host — a CPU board).
    ch.on('broadcast', { event: 'attack' }, ({ payload }) => this.cb.onAttack?.(payload as AttackMsg));
    ch.on('broadcast', { event: 'dead' }, ({ payload }) => this.cb.onDead?.(payload as DeadMsg));

    await new Promise<void>((resolve) => {
      ch.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await ch.track(this.presence());
          if (this.isOwner) this.broadcastRoomState();
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this.cb.onError?.('room-join-failed');
          resolve();
        }
      });
    });
  }

  private presence(): PresenceState {
    return { id: this.id, name: this.name, ready: this.myReady, joinedAt: this.joinedAt };
  }

  private humans(): PresenceState[] {
    const ch = this.roomCh;
    if (!ch) return [{ ...this.presence() }];
    const state = ch.presenceState() as Record<string, Array<Record<string, unknown>>>;
    const list: PresenceState[] = [];
    for (const key of Object.keys(state)) {
      const meta = state[key]?.[0] as unknown as PresenceState | undefined;
      if (meta && meta.id) list.push(meta);
    }
    list.sort((a, b) => a.joinedAt - b.joinedAt);
    return list;
  }

  private emitLobby() {
    const humans = this.humans();
    // Owner = earliest-joined human (deterministic).
    if (humans.length && humans[0].id === this.id && !this.isOwner) {
      // promoted to owner (previous owner left)
      this.isOwner = true;
      this.room.hostId = this.id;
      this.advertise();
      this.broadcastRoomState();
    }
    this.cb.onLobby?.(humans, this.room);
    if (this.isOwner) this.advertise();
  }

  // ── Lobby advertisement (owner only) ─────────────────────────
  private async advertise() {
    const lobby = this.lobbyCh;
    if (!lobby || !this.isOwner) return;
    const ad: RoomAd = {
      roomId: this.roomId, hostId: this.id,
      count: this.humans().length, started: this.room.started, updatedAt: Date.now(),
    };
    try { await lobby.track(ad as unknown as Record<string, unknown>); } catch { /* */ }
  }

  private broadcastRoomState() {
    this.roomCh?.send({ type: 'broadcast', event: 'roomstate', payload: this.room });
  }

  // ── Public lobby controls ────────────────────────────────────
  setReady(ready: boolean) {
    this.myReady = ready;
    this.roomCh?.track(this.presence());
  }

  addCpu(index: number, level: CpuLevel) {
    if (!this.isOwner) return;
    this.room.cpus = this.room.cpus.filter((c) => c.index !== index);
    this.room.cpus.push({ index, level, name: `CPU Lv${level}` });
    this.broadcastRoomState();
    this.emitLobby();
  }

  removeCpu(index: number) {
    if (!this.isOwner) return;
    this.room.cpus = this.room.cpus.filter((c) => c.index !== index);
    this.broadcastRoomState();
    this.emitLobby();
  }

  startGame(order: string[], seed: number) {
    if (!this.isOwner) return;
    this.room.started = true;
    this.room.order = order;
    this.room.seed = seed;
    this.broadcastRoomState();
    this.advertise();
    this.roomCh?.send({ type: 'broadcast', event: 'start', payload: { seed, order } as StartMsg });
  }

  // ── Gameplay messages ────────────────────────────────────────
  sendSnapshot(msg: SnapshotMsg) {
    this.roomCh?.send({ type: 'broadcast', event: 'snapshot', payload: msg });
  }
  sendAttack(msg: AttackMsg) {
    this.roomCh?.send({ type: 'broadcast', event: 'attack', payload: msg });
  }
  sendDead(msg: DeadMsg) {
    this.roomCh?.send({ type: 'broadcast', event: 'dead', payload: msg });
  }

  async leave() {
    const sb = getSupabaseBrowser();
    try { if (this.roomCh) await sb?.removeChannel(this.roomCh); } catch { /* */ }
    try { if (this.lobbyCh) await sb?.removeChannel(this.lobbyCh); } catch { /* */ }
    this.roomCh = null;
    this.lobbyCh = null;
  }
}
