'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { MONSTERS, MAX_LEVEL } from '@/lib/monsters';
import { buildSprite, rrect, type Sprite } from '@/lib/sprites';
import { drawMonster, drawOre } from '@/lib/draw';
import { LocalBoard, type MergeFx } from '@/lib/battle/board';
import { CpuController } from '@/lib/battle/cpu';
import { BattleNet } from '@/lib/battle/net';
import {
  BW, B_H, B_GL, B_GR, B_CEILING_Y, B_FLOOR_Y, B_DROP_Y, B_WALL,
  SNAPSHOT_INTERVAL, FORCE_CPU_MS, MAX_PLAYERS, placeLabel, clientId,
  type SnapshotMsg, type PresenceState, type RoomState, type CpuLevel, type BattlePhase,
} from '@/lib/battle/types';
import { isOnlineConfigured } from '@/lib/supabaseClient';

const PLAYER_NAME_KEY = 'sporinkaPlayerName';
const BOARD_ASPECT = BW / B_H;

interface Slot {
  id: string;
  name: string;
  kind: 'human' | 'cpu' | 'empty';
  cpuLevel?: CpuLevel;
  isOwner: boolean;
  index: number;
}

// Visual fly-ore burst from one board to another.
interface FlyOre { fromId: string; toId: string; start: number; count: number; }
interface Burst { id: string; x: number; y: number; color: string; big: boolean; start: number; }

export default function BattleGame({ onExit }: { onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const procRef = useRef<Map<number, Sprite>>(new Map());

  const [phase, setPhase] = useState<BattlePhase>('orient');
  const phaseRef = useRef<BattlePhase>('orient');
  const setPhaseBoth = (p: BattlePhase) => { phaseRef.current = p; setPhase(p); };

  const [isLandscape, setIsLandscape] = useState(true);
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');         // lobby connection status text
  const [humans, setHumans] = useState<PresenceState[]>([]);
  const [room, setRoom] = useState<RoomState>({ hostId: '', started: false, cpus: [] });
  const [ready, setReady] = useState(false);
  const [count, setCount] = useState(3);
  const [results, setResults] = useState<{ name: string; place: number; isSelf: boolean }[]>([]);

  const netRef = useRef<BattleNet | null>(null);
  const selfId = clientId();
  const isOwnerRef = useRef(false);
  const offlineRef = useRef(false);

  // Boards I simulate locally (always my own; CPU boards too if I'm host).
  const boardsRef = useRef<Map<string, LocalBoard>>(new Map());
  const cpusRef = useRef<Map<string, CpuController>>(new Map());
  const snapsRef = useRef<Map<string, SnapshotMsg>>(new Map());
  const orderRef = useRef<string[]>([]);
  const namesRef = useRef<Map<string, string>>(new Map());
  const placementsRef = useRef<Map<string, number>>(new Map());
  const rectsRef = useRef<Map<string, { x: number; y: number; w: number; h: number }>>(new Map());
  const flyRef = useRef<FlyOre[]>([]);
  const burstRef = useRef<Burst[]>([]);
  const rafRef = useRef(0);
  const lastSnapRef = useRef(0);
  const matterRef = useRef<typeof import('matter-js') | null>(null);

  // ── Preprocess monster sprites (same as the solo game) ──
  useEffect(() => {
    MONSTERS.forEach((m) => {
      const img = new Image();
      img.onload = () => {
        try {
          const sp = buildSprite(img, { keepLargest: m.keepLargest, erase: m.erase });
          if (sp) procRef.current.set(m.id, sp);
        } catch { /* */ }
      };
      img.src = m.imageSrc;
    });
  }, []);

  // ── Orientation detection ──
  useEffect(() => {
    const check = () => {
      const land = window.innerWidth >= window.innerHeight;
      setIsLandscape(land);
    };
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    // best-effort lock (works only in fullscreen on some browsers)
    try {
      const so = (screen.orientation as unknown as { lock?: (o: string) => Promise<void> });
      so?.lock?.('landscape').catch(() => {});
    } catch { /* */ }
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, []);

  // ── Load saved name ──
  useEffect(() => {
    let n = '';
    try { n = localStorage.getItem(PLAYER_NAME_KEY) ?? ''; } catch { /* */ }
    setName(n);
  }, []);

  // ── Helpers ────────────────────────────────────────────────
  const alive = useCallback((id: string) => {
    if (placementsRef.current.has(id)) return false;
    const lb = boardsRef.current.get(id);
    if (lb) return !lb.dead;
    const sn = snapsRef.current.get(id);
    return !(sn && sn.dead);
  }, []);

  const pickTarget = useCallback((excludeId: string): string | null => {
    const cands = orderRef.current.filter((id) => id !== excludeId && alive(id));
    if (!cands.length) return null;
    return cands[Math.floor(Math.random() * cands.length)];
  }, [alive]);

  // Route an attack emitted by a board I simulate.
  const routeAttack = useCallback((fromId: string, count: number) => {
    const target = pickTarget(fromId);
    if (!target) return;
    flyRef.current.push({ fromId, toId: target, start: Date.now(), count });
    const lb = boardsRef.current.get(target);
    if (lb) lb.receiveOre(count);                 // I simulate the target
    else netRef.current?.sendAttack({ from: fromId, to: target, count });
  }, [pickTarget]);

  // ── Placement (host-authoritative) ─────────────────────────
  const finishIfDone = useCallback(() => {
    if (placementsRef.current.size >= orderRef.current.length && orderRef.current.length > 0) {
      const rows = orderRef.current.map((id) => ({
        name: namesRef.current.get(id) ?? id,
        place: placementsRef.current.get(id) ?? MAX_PLAYERS,
        isSelf: id === selfId,
      })).sort((a, b) => a.place - b.place);
      setResults(rows);
      setPhaseBoth('result');
    }
  }, [selfId]);

  const assignPlace = useCallback((id: string) => {
    if (placementsRef.current.has(id)) return;
    // Players still alive AFTER this death (exclude the one dying explicitly,
    // so it works regardless of when the dead flag/snapshot lands).
    const others = orderRef.current.filter((x) => x !== id && alive(x));
    const place = others.length + 1;          // first to die in a 4-way = 4th
    placementsRef.current.set(id, place);
    netRef.current?.sendDead({ id, place });
    // Only one left alive → they win (1st place); the match is over.
    if (others.length === 1) {
      placementsRef.current.set(others[0], 1);
      netRef.current?.sendDead({ id: others[0], place: 1 });
    }
    finishIfDone();
  }, [alive, finishIfDone]);

  // A board I simulate just died.
  const onLocalDeath = useCallback((id: string) => {
    if (isOwnerRef.current) {
      assignPlace(id);
    } else if (id === selfId) {
      // report to host; host assigns the authoritative place
      netRef.current?.sendDead({ id: selfId, place: 0 });
    }
  }, [assignPlace, selfId, isOwnerRef]);

  // ── Begin the match (shared by owner + members) ────────────
  const beginGame = useCallback(async (order: string[], seed: number) => {
    const M = matterRef.current ?? (await import('matter-js'));
    matterRef.current = M;
    orderRef.current = order;
    placementsRef.current.clear();
    snapsRef.current.clear();
    flyRef.current = [];
    burstRef.current = [];
    boardsRef.current.forEach((b) => b.destroy());
    boardsRef.current.clear();
    cpusRef.current.clear();

    const onMerge = (id: string) => (fx: MergeFx) => {
      burstRef.current.push({
        id, x: fx.x, y: fx.y, start: Date.now(),
        color: fx.level >= MAX_LEVEL ? '#c8a0ff' : MONSTERS[fx.level].glowColor,
        big: fx.big,
      });
    };

    // My own human board.
    const mine = new LocalBoard(M, procRef.current, {
      onAttack: (c) => routeAttack(selfId, c),
      onMerge: onMerge(selfId),
      onDead: () => onLocalDeath(selfId),
    }, seed);
    boardsRef.current.set(selfId, mine);

    // Host simulates every CPU board.
    if (isOwnerRef.current) {
      order.forEach((id, i) => {
        if (!id.startsWith('cpu_')) return;
        const level = (room.cpus.find((c) => `cpu_${c.index}` === id)?.level ?? 3) as CpuLevel;
        const cb = new LocalBoard(M, procRef.current, {
          onAttack: (c) => routeAttack(id, c),
          onMerge: onMerge(id),
          onDead: () => onLocalDeath(id),
        }, seed + i * 7919);
        boardsRef.current.set(id, cb);
        cpusRef.current.set(id, new CpuController(cb, level, seed + i * 104729));
      });
    }

    setCount(3);
    setPhaseBoth('countdown');
  }, [room.cpus, routeAttack, selfId, onLocalDeath]);

  // ── Networking setup ───────────────────────────────────────
  useEffect(() => {
    if (phase !== 'lobby') return;
    let cancelled = false;
    const online = isOnlineConfigured();
    offlineRef.current = !online;

    if (!online) {
      // Offline: single-player room, you are the host; add CPUs to play.
      isOwnerRef.current = true;
      setStatus('オフライン（CPU対戦）');
      const me: PresenceState = { id: selfId, name, ready: true, joinedAt: Date.now() };
      setHumans([me]);
      namesRef.current.set(selfId, name || 'あなた');
      setRoom({ hostId: selfId, started: false, cpus: [] });
      setReady(true);
      return;
    }

    const net = new BattleNet({
      onRoom: (roomId, isOwner) => {
        isOwnerRef.current = isOwner;
        setStatus(isOwner ? `ルーム作成（オーナー）` : `ルームに参加`);
      },
      onLobby: (hs, rm) => {
        if (cancelled) return;
        setHumans(hs);
        setRoom(rm);
        isOwnerRef.current = (hs[0]?.id === selfId);
        hs.forEach((h) => namesRef.current.set(h.id, h.name));
        rm.cpus.forEach((c) => namesRef.current.set(`cpu_${c.index}`, c.name));
      },
      onStart: (msg) => {
        msg.order.forEach((id) => { if (!namesRef.current.has(id)) namesRef.current.set(id, id); });
        beginGame(msg.order, msg.seed);
      },
      onSnapshot: (msg) => { snapsRef.current.set(msg.id, msg); },
      onAttack: (msg) => {
        const lb = boardsRef.current.get(msg.to);
        if (lb) { lb.receiveOre(msg.count); }
      },
      onDead: (msg) => {
        if (isOwnerRef.current) {
          if (msg.place === 0) assignPlace(msg.id);     // a human reported death
          else { placementsRef.current.set(msg.id, msg.place); finishIfDone(); }
        } else if (msg.place > 0) {
          placementsRef.current.set(msg.id, msg.place);
          finishIfDone();
        }
      },
      onError: (reason) => {
        if (reason === 'not-configured') {
          offlineRef.current = true;
          isOwnerRef.current = true;
          setStatus('オフライン（CPU対戦）');
        } else setStatus('接続エラー: ' + reason);
      },
    });
    netRef.current = net;
    namesRef.current.set(selfId, name || 'あなた');
    setStatus('マッチング中…');
    net.connect(name || 'あなた');

    return () => {
      cancelled = true;
      net.leave();
    };
  }, [phase, name, selfId, beginGame, assignPlace, finishIfDone]);

  // ── Owner: 1-minute force-CPU auto start ───────────────────
  useEffect(() => {
    if (phase !== 'lobby' || !isOwnerRef.current || offlineRef.current) return;
    const t = setTimeout(() => {
      if (phaseRef.current !== 'lobby') return;
      // fill empty slots with CPU Lv3 (ensuring >=2 participants), then start
      const cpus = room.cpus.slice();
      let idx = humans.length + cpus.length;
      while (humans.length + cpus.length < MAX_PLAYERS) {
        cpus.push({ index: idx, level: 3 as CpuLevel, name: 'CPU Lv3' });
        idx++;
      }
      applyCpus(cpus);
      setTimeout(() => doStart(), 300);
    }, FORCE_CPU_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, humans.length, room.cpus.length]);

  // ── Lobby controls ─────────────────────────────────────────
  const slots: Slot[] = (() => {
    const out: Slot[] = [];
    humans.forEach((h, i) => out.push({
      id: h.id, name: h.name || 'プレイヤー', kind: 'human',
      isOwner: i === 0, index: out.length,
    }));
    room.cpus.slice().sort((a, b) => a.index - b.index).forEach((c) => out.push({
      id: `cpu_${c.index}`, name: c.name, kind: 'cpu', cpuLevel: c.level,
      isOwner: false, index: out.length,
    }));
    while (out.length < MAX_PLAYERS) out.push({ id: `empty_${out.length}`, name: '', kind: 'empty', isOwner: false, index: out.length });
    return out;
  })();

  const participantCount = humans.length + room.cpus.length;

  const toggleReady = () => {
    const v = !ready;
    setReady(v);
    netRef.current?.setReady(v);
  };

  const buildOrder = useCallback((): string[] => {
    const order: string[] = [];
    humans.forEach((h) => order.push(h.id));
    room.cpus.slice().sort((a, b) => a.index - b.index).forEach((c) => order.push(`cpu_${c.index}`));
    return order;
  }, [humans, room.cpus]);

  const doStart = useCallback(() => {
    const order = buildOrder();
    if (order.length < 2) return;
    const seed = Math.floor(Math.random() * 1e9);
    if (offlineRef.current) {
      beginGame(order, seed);
    } else {
      netRef.current?.startGame(order, seed);
      beginGame(order, seed);
    }
  }, [buildOrder, beginGame]);

  // Update the CPU list optimistically (instant UI feedback) AND, when
  // online, broadcast it. This doesn't rely on the net layer's internal
  // owner flag, so it can never silently no-op for the room owner.
  const applyCpus = (cpus: { index: number; level: CpuLevel; name: string }[]) => {
    setRoom((r) => ({ ...r, cpus }));
    cpus.forEach((c) => namesRef.current.set(`cpu_${c.index}`, c.name));
    if (!offlineRef.current) netRef.current?.setCpus(cpus);
  };
  const addCpu = (index: number, level: CpuLevel) => {
    const cur = room.cpus.filter((c) => c.index !== index);
    applyCpus([...cur, { index, level, name: `CPU Lv${level}` }]);
  };
  const removeCpu = (index: number) => {
    applyCpus(room.cpus.filter((c) => c.index !== index));
  };

  // ── Countdown ──────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'countdown') return;
    let n = 3;
    setCount(3);
    const iv = setInterval(() => {
      n -= 1;
      if (n <= 0) { clearInterval(iv); setPhaseBoth('playing'); }
      else setCount(n);
    }, 800);
    return () => clearInterval(iv);
  }, [phase]);

  // ── Layout: rects for each board ───────────────────────────
  const computeRects = useCallback((cw: number, ch: number) => {
    const order = orderRef.current;
    const opp = order.filter((id) => id !== selfId);
    const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
    const pad = 10;
    const PLATE = 26; // reserve room under each board for the name/score plate
    const fit = (ax: number, ay: number, aw: number, ah: number) => {
      const ah2 = Math.max(40, ah - PLATE);
      let w = aw, h = w / BOARD_ASPECT;
      if (h > ah2) { h = ah2; w = h * BOARD_ASPECT; }
      return { x: ax + (aw - w) / 2, y: ay + (ah2 - h) / 2, w, h };
    };
    if (opp.length === 0) {
      rects.set(selfId, fit(pad, pad, cw - 2 * pad, ch - 2 * pad));
      return rects;
    }
    // self large on the left, opponents stacked on the right
    const leftW = cw * 0.6;
    rects.set(selfId, fit(pad, pad, leftW - 1.5 * pad, ch - 2 * pad));
    const rightX = leftW + pad * 0.5;
    const rightW = cw - rightX - pad;
    const cellH = (ch - 2 * pad) / opp.length;
    opp.forEach((id, i) => {
      rects.set(id, fit(rightX, pad + i * cellH, rightW, cellH - pad * 0.6));
    });
    return rects;
  }, [selfId]);

  // ── Draw one board ─────────────────────────────────────────
  const drawBoard = useCallback((
    ctx: CanvasRenderingContext2D,
    id: string,
    rect: { x: number; y: number; w: number; h: number },
    isSelf: boolean,
  ) => {
    const s = rect.w / BW;
    ctx.save();
    ctx.translate(rect.x, rect.y);
    ctx.scale(s, s);

    // field background
    ctx.fillStyle = 'rgba(7,7,30,0.82)';
    ctx.fillRect(0, 0, BW, B_H);

    // walls
    ctx.fillStyle = '#0c0c2a';
    ctx.fillRect(0, 0, B_WALL, B_H);
    ctx.fillRect(B_GR, 0, B_WALL, B_H);
    ctx.fillRect(0, B_FLOOR_Y, BW, B_H - B_FLOOR_Y);
    ctx.strokeStyle = isSelf ? '#ffe050' : '#2a1e60';
    ctx.lineWidth = isSelf ? 4 : 2;
    ctx.strokeRect(1, 1, BW - 2, B_H - 2);

    // danger line
    ctx.save();
    ctx.strokeStyle = 'rgba(255,48,48,0.8)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 5]);
    ctx.beginPath(); ctx.moveTo(B_GL, B_CEILING_Y); ctx.lineTo(B_GR, B_CEILING_Y); ctx.stroke();
    ctx.restore();

    // contents
    const lb = boardsRef.current.get(id);
    let cur = 0, next = 1, dropX = BW / 2, pending = 0, score = 0, dead = false;
    if (lb) {
      lb.forEachBody((level, x, y, angle, sq, merging) => {
        if (level < 0) drawOre(ctx, x, y, 13, Math.round(x));
        else drawMonster(ctx, x, y, level, procRef.current, { angle, squash: sq, alpha: merging ? 0.5 : 1 });
      });
      cur = lb.currentLevel; next = lb.nextLevel; dropX = lb.dropX;
      pending = lb.pendingOre; score = lb.score; dead = lb.dead;
    } else {
      const sn = snapsRef.current.get(id);
      if (sn) {
        for (let i = 0; i + 1 < sn.o.length; i += 2) drawOre(ctx, sn.o[i], sn.o[i + 1], 13, sn.o[i]);
        for (let i = 0; i + 3 < sn.b.length; i += 4) {
          drawMonster(ctx, sn.b[i + 1], sn.b[i + 2], sn.b[i], procRef.current, { angle: sn.b[i + 3] / 100 });
        }
        cur = sn.cur; next = sn.next; dropX = sn.dropX; pending = sn.pending; score = sn.score; dead = sn.dead;
      }
    }

    // current block at the dropper (only while alive)
    if (!dead) {
      drawMonster(ctx, dropX, B_DROP_Y, cur, procRef.current, { alpha: 0.95 });
      if (isSelf) {
        ctx.save();
        ctx.strokeStyle = 'rgba(180,180,255,0.25)';
        ctx.lineWidth = 1; ctx.setLineDash([5, 7]);
        ctx.beginPath(); ctx.moveTo(dropX, B_DROP_Y + MONSTERS[cur].radius + 2); ctx.lineTo(dropX, B_FLOOR_Y); ctx.stroke();
        ctx.restore();
      }
    }

    // NEXT mini (top-right corner of board)
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    rrect(ctx, B_GR - 60, 6, 54, 30, 6); ctx.fill();
    ctx.fillStyle = '#c8a030'; ctx.font = 'bold 9px "Noto Sans JP"'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('NEXT', B_GR - 56, 9);
    ctx.save(); ctx.translate(B_GR - 22, 22); ctx.scale(0.5, 0.5);
    drawMonster(ctx, 0, 0, next, procRef.current, { alpha: 0.9 });
    ctx.restore();
    ctx.restore();

    // pending-ore waiting area indicator (top-left)
    if (pending > 0) {
      ctx.save();
      ctx.fillStyle = 'rgba(60,20,90,0.85)';
      rrect(ctx, 8, 6, 70, 26, 6); ctx.fill();
      drawOre(ctx, 22, 19, 9, 1);
      ctx.fillStyle = '#e8d24a'; ctx.font = 'bold 14px "Oswald", sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText('×' + pending, 34, 20);
      ctx.restore();
    }

    // dead overlay
    if (dead) {
      ctx.fillStyle = 'rgba(40,0,0,0.6)';
      ctx.fillRect(0, 0, BW, B_H);
      const pl = placementsRef.current.get(id);
      ctx.fillStyle = '#ff6060'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = 'bold 40px "Noto Serif JP", serif';
      ctx.fillText(pl ? placeLabel(pl) : 'OUT', BW / 2, B_H / 2 - 10);
    }

    ctx.restore();

    // name + score plate UNDER the board (screen space)
    const plateH = 22;
    ctx.save();
    ctx.fillStyle = isSelf ? 'rgba(58,42,0,0.9)' : 'rgba(8,8,28,0.9)';
    rrect(ctx, rect.x, rect.y + rect.h + 2, rect.w, plateH, 5); ctx.fill();
    ctx.strokeStyle = isSelf ? '#ffe050' : '#3a3a60'; ctx.lineWidth = 1;
    rrect(ctx, rect.x, rect.y + rect.h + 2, rect.w, plateH, 5); ctx.stroke();
    ctx.fillStyle = isSelf ? '#fffadc' : '#e0d8c0';
    ctx.font = `bold ${Math.min(14, rect.w / 12)}px "Noto Sans JP"`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const nm = (namesRef.current.get(id) ?? 'CPU').slice(0, 10);
    ctx.fillText((isSelf ? '★ ' : '') + nm, rect.x + 8, rect.y + rect.h + 2 + plateH / 2);
    ctx.textAlign = 'right'; ctx.fillStyle = '#ffe050';
    ctx.font = 'bold 13px "Oswald", sans-serif';
    ctx.fillText(String(score), rect.x + rect.w - 8, rect.y + rect.h + 2 + plateH / 2);
    ctx.restore();
  }, []);

  // ── Main render + simulation loop ──────────────────────────
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'countdown') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let last = 0;
    const loop = (ts: number) => {
      const dt = last ? ts - last : 16;
      last = ts;

      const cw = canvas.width, ch = canvas.height;
      const rects = computeRects(cw, ch);
      rectsRef.current = rects;

      if (phaseRef.current === 'playing') {
        // CPU think + step my boards
        if (isOwnerRef.current) cpusRef.current.forEach((c) => c.think());
        boardsRef.current.forEach((b) => { b.step(dt); });

        // broadcast snapshots
        if (ts - lastSnapRef.current > SNAPSHOT_INTERVAL) {
          lastSnapRef.current = ts;
          const net = netRef.current;
          if (net && !offlineRef.current) {
            boardsRef.current.forEach((b, id) => net.sendSnapshot(b.serialize(id)));
          }
        }
      }

      // render
      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = '#05050f';
      ctx.fillRect(0, 0, cw, ch);

      orderRef.current.forEach((id) => {
        const rect = rects.get(id);
        if (rect) drawBoard(ctx, id, rect, id === selfId);
      });

      drawFx(ctx);

      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, computeRects, drawBoard, selfId]);

  // ── FX: merge bursts + flying ore ──────────────────────────
  const drawFx = useCallback((ctx: CanvasRenderingContext2D) => {
    const now = Date.now();
    // merge bursts (in their board's local space)
    const bursts = burstRef.current;
    for (let i = bursts.length - 1; i >= 0; i--) {
      const b = bursts[i];
      const t = (now - b.start) / 420;
      if (t >= 1) { bursts.splice(i, 1); continue; }
      const rect = rectsRef.current.get(b.id);
      if (!rect) continue;
      const s = rect.w / BW;
      const x = rect.x + b.x * s, y = rect.y + b.y * s;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (1 - t) * 0.9;
      const R = (b.big ? 60 : 38) * s * (0.3 + t);
      ctx.strokeStyle = b.color; ctx.lineWidth = 4 * (1 - t) + 1;
      ctx.shadowColor = b.color; ctx.shadowBlur = 18;
      ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    // flying ore from attacker board → target waiting area
    const flies = flyRef.current;
    for (let i = flies.length - 1; i >= 0; i--) {
      const f = flies[i];
      const dur = 650;
      const t = (now - f.start) / dur;
      if (t >= 1) { flies.splice(i, 1); continue; }
      const fr = rectsRef.current.get(f.fromId), to = rectsRef.current.get(f.toId);
      if (!fr || !to) continue;
      const x0 = fr.x + fr.w / 2, y0 = fr.y + fr.h / 2;
      const x1 = to.x + to.w * 0.18, y1 = to.y + 18;
      const ease = t * t * (3 - 2 * t);
      const arc = Math.sin(t * Math.PI) * 60;
      const n = Math.min(f.count, 6);
      for (let k = 0; k < n; k++) {
        const off = (k - n / 2) * 8;
        const x = x0 + (x1 - x0) * ease + off * (1 - t);
        const y = y0 + (y1 - y0) * ease - arc;
        drawOre(ctx, x, y, 9 + 3 * (1 - t), k);
      }
    }
  }, []);

  // ── Input: swipe anywhere moves drop; tap drops ────────────
  useEffect(() => {
    if (phase !== 'playing') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let downX = 0, downT = 0, moved = false;
    const toBoardX = (clientX: number) => {
      // map across the whole window so swiping ANYWHERE works (spec ①)
      const frac = Math.max(0, Math.min(1, clientX / window.innerWidth));
      return B_GL + frac * (B_GR - B_GL);
    };
    const move = (clientX: number) => {
      const b = boardsRef.current.get(selfId);
      if (b && !b.dead) b.moveTo(toBoardX(clientX));
    };
    const onDown = (x: number) => { downX = x; downT = Date.now(); moved = false; move(x); };
    const onMove = (x: number) => { if (Math.abs(x - downX) > 6) moved = true; move(x); };
    const onUp = () => {
      const b = boardsRef.current.get(selfId);
      if (!b || b.dead) return;
      if (!moved && Date.now() - downT < 400) b.drop();
      else if (moved) b.drop(); // a swipe also drops at the chosen spot
    };
    const md = (e: MouseEvent) => onDown(e.clientX);
    const mm = (e: MouseEvent) => { if (e.buttons) onMove(e.clientX); };
    const mu = () => onUp();
    const ts = (e: TouchEvent) => { e.preventDefault(); onDown(e.touches[0].clientX); };
    const tm = (e: TouchEvent) => { e.preventDefault(); onMove(e.touches[0].clientX); };
    const te = (e: TouchEvent) => { e.preventDefault(); onUp(); };
    canvas.addEventListener('mousedown', md);
    canvas.addEventListener('mousemove', mm);
    canvas.addEventListener('mouseup', mu);
    canvas.addEventListener('touchstart', ts, { passive: false });
    canvas.addEventListener('touchmove', tm, { passive: false });
    canvas.addEventListener('touchend', te, { passive: false });
    return () => {
      canvas.removeEventListener('mousedown', md);
      canvas.removeEventListener('mousemove', mm);
      canvas.removeEventListener('mouseup', mu);
      canvas.removeEventListener('touchstart', ts);
      canvas.removeEventListener('touchmove', tm);
      canvas.removeEventListener('touchend', te);
    };
  }, [phase, selfId]);

  // ── Canvas sizing ──────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [phase]);

  // ── Cleanup on unmount ─────────────────────────────────────
  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    boardsRef.current.forEach((b) => b.destroy());
    netRef.current?.leave();
  }, []);

  const goLobby = () => {
    try { localStorage.setItem(PLAYER_NAME_KEY, name); } catch { /* */ }
    setPhaseBoth('lobby');
  };

  // ═══════════════ RENDER ═══════════════
  return (
    <div style={{ position: 'fixed', inset: 0, background: '#05050f', overflow: 'hidden', zIndex: 50 }}>
      <canvas ref={canvasRef} style={{ display: 'block', touchAction: 'none', position: 'absolute', inset: 0 }} />

      {/* Exit button (always) */}
      <button onClick={onExit} style={exitBtn}>✕ TOPへ</button>

      {/* Orientation gate */}
      {!isLandscape && (
        <Overlay>
          <div style={{ textAlign: 'center', color: '#f0e0b0' }}>
            <div style={{ fontSize: 64, marginBottom: 16 }}>📱↻</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>横画面にしてください</div>
            <div style={{ fontSize: 13, color: '#8a7a50' }}>対戦モードは横画面でプレイします</div>
          </div>
        </Overlay>
      )}

      {/* Entry (orient phase = enter name) */}
      {isLandscape && phase === 'orient' && (
        <Overlay>
          <Panel title="⚔ 対戦モード">
            <div style={{ fontSize: 12, color: '#8a7a50', marginBottom: 12, textAlign: 'center' }}>
              {isOnlineConfigured() ? 'オンラインで最大4人対戦' : 'オフライン（CPU対戦）'}
            </div>
            <label style={{ fontSize: 12, color: '#c8a030' }}>プレイヤー名</label>
            <input value={name} maxLength={10} onChange={(e) => setName(e.target.value)} placeholder="あなた" style={inputStyle} />
            <button onClick={goLobby} style={primaryBtn}>ルームへ</button>
          </Panel>
        </Overlay>
      )}

      {/* Lobby */}
      {isLandscape && phase === 'lobby' && (
        <Overlay>
          <Panel title="⚔ 対戦ルーム" wide>
            <div style={{ fontSize: 11, color: '#8a7a50', textAlign: 'center', marginBottom: 10 }}>
              {offlineRef.current ? '🔌 オフライン（CPU対戦）' : '🌐 オンライン'}
              {isOwnerRef.current ? '・👑 あなたがオーナー' : '・参加者'}
              {`・参加 ${participantCount}人`}
              {status ? `（${status}）` : ''}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10 }}>
              {slots.map((s) => (
                <div key={s.index} style={{
                  border: `1.5px solid ${s.kind === 'empty' ? '#3a3a60' : '#c8a030'}`,
                  borderRadius: 8, padding: 10, background: 'rgba(8,8,28,0.7)', minHeight: 78,
                }}>
                  {s.kind === 'human' && (
                    <div>
                      <div style={{ color: '#f0e0b0', fontWeight: 700, fontSize: 14 }}>
                        {s.isOwner ? '👑 ' : ''}{s.name}{s.id === selfId ? '（あなた）' : ''}
                      </div>
                      <div style={{ fontSize: 11, color: humans.find((h) => h.id === s.id)?.ready ? '#6cff9a' : '#8a7a50', marginTop: 4 }}>
                        {humans.find((h) => h.id === s.id)?.ready ? '✓ 準備完了' : '… 準備中'}
                      </div>
                    </div>
                  )}
                  {s.kind === 'cpu' && (
                    <div>
                      <div style={{ color: '#a0d0ff', fontWeight: 700, fontSize: 14 }}>🤖 {s.name}</div>
                      {isOwnerRef.current && (
                        <button onClick={() => removeCpu(parseInt(s.id.slice(4)))} style={smallBtn}>解除</button>
                      )}
                    </div>
                  )}
                  {s.kind === 'empty' && (
                    <div>
                      <div style={{ color: '#6a6a90', fontSize: 12, marginBottom: 6 }}>空き枠</div>
                      {isOwnerRef.current ? (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 10, color: '#8a7a50', width: '100%' }}>CPUへ切り替え（強さ）</span>
                          {[1, 2, 3, 4, 5].map((lv) => (
                            <button key={lv} onClick={() => addCpu(s.index, lv as CpuLevel)} style={cpuLvBtn}>Lv{lv}</button>
                          ))}
                        </div>
                      ) : (
                        <div style={{ fontSize: 11, color: '#6a6a90' }}>参加待ち…</div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 14, justifyContent: 'center' }}>
              {!offlineRef.current && (
                <button onClick={toggleReady} style={ready ? primaryBtn : secondaryBtn}>
                  {ready ? '✓ 準備完了' : 'OK（準備完了）'}
                </button>
              )}
              {isOwnerRef.current && (
                <button
                  onClick={doStart}
                  disabled={participantCount < 2}
                  style={{ ...primaryBtn, opacity: participantCount < 2 ? 0.4 : 1, cursor: participantCount < 2 ? 'default' : 'pointer' }}
                >
                  ⚔ 対戦スタート（{participantCount}人）
                </button>
              )}
            </div>
            {isOwnerRef.current && !offlineRef.current && (
              <div style={{ fontSize: 10, color: '#6a6a90', textAlign: 'center', marginTop: 8 }}>
                ※2人以上で開始できます。1分経過で空き枠は自動的にCPUになり開始します。
              </div>
            )}
          </Panel>
        </Overlay>
      )}

      {/* Countdown */}
      {phase === 'countdown' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <div style={{ fontSize: 120, fontWeight: 900, color: '#ffe050', textShadow: '0 0 30px #ff8000' }}>{count}</div>
        </div>
      )}

      {/* Result */}
      {phase === 'result' && (
        <Overlay>
          <Panel title="🏆 リザルト">
            {results.map((r) => (
              <div key={r.name + r.place} style={{
                display: 'flex', justifyContent: 'space-between', padding: '8px 12px', marginBottom: 6,
                borderRadius: 8, fontSize: 16,
                background: r.place === 1 ? 'rgba(255,210,80,0.16)' : 'rgba(8,8,28,0.7)',
                border: `1px solid ${r.place === 1 ? '#ffd24a' : '#3a3a60'}`,
                color: r.isSelf ? '#fff3c0' : '#e0d8c0', fontWeight: r.isSelf ? 700 : 400,
              }}>
                <span>{placeLabel(r.place)}{r.place === 1 ? ' 👑' : ''}</span>
                <span>{r.name}{r.isSelf ? '（あなた）' : ''}</span>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 10, marginTop: 14, justifyContent: 'center' }}>
              <button onClick={() => setPhaseBoth('lobby')} style={secondaryBtn}>もう一度</button>
              <button onClick={onExit} style={primaryBtn}>TOPへ</button>
            </div>
          </Panel>
        </Overlay>
      )}
    </div>
  );
}

// ── Small styled helpers ──────────────────────────────────────
function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, background: 'rgba(4,4,20,0.86)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20,
      fontFamily: '"Noto Sans JP", sans-serif',
    }}>{children}</div>
  );
}
function Panel({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{
      background: 'rgba(8,8,28,0.97)', border: '1.5px solid #c8a030', borderRadius: 14,
      padding: '20px 24px', width: wide ? 560 : 340, maxWidth: '92vw', maxHeight: '90vh', overflowY: 'auto',
    }}>
      <h2 style={{ textAlign: 'center', color: '#c8a030', margin: '0 0 16px', fontSize: 20 }}>{title}</h2>
      {children}
    </div>
  );
}

const exitBtn: React.CSSProperties = {
  position: 'absolute', top: 8, left: 8, zIndex: 30,
  background: 'rgba(6,6,28,0.88)', border: '1.5px solid #c8a030', borderRadius: 8,
  color: '#f0e0b0', fontSize: 12, padding: '6px 12px', cursor: 'pointer',
  fontFamily: '"Noto Sans JP", sans-serif',
};
const inputStyle: React.CSSProperties = {
  display: 'block', width: '100%', boxSizing: 'border-box', margin: '6px 0 16px',
  background: 'rgba(0,0,0,0.5)', border: '2px solid #fff', borderRadius: 6,
  color: '#fff', fontSize: 15, fontWeight: 700, textAlign: 'center', padding: '8px', outline: 'none',
};
const primaryBtn: React.CSSProperties = {
  background: 'linear-gradient(180deg,#3a2a00,#c8a030,#3a2a00)', border: '2px solid #ffe050',
  borderRadius: 8, color: '#fffadc', fontSize: 15, fontWeight: 700, padding: '10px 22px', cursor: 'pointer',
  fontFamily: '"Noto Sans JP", sans-serif',
};
const secondaryBtn: React.CSSProperties = {
  background: 'rgba(10,10,36,0.7)', border: '1.5px solid #c8a030',
  borderRadius: 8, color: '#f0e0b0', fontSize: 14, padding: '10px 18px', cursor: 'pointer',
  fontFamily: '"Noto Sans JP", sans-serif',
};
const smallBtn: React.CSSProperties = {
  marginTop: 6, background: 'rgba(10,10,36,0.8)', border: '1px solid #6a4a4a',
  borderRadius: 6, color: '#d09090', fontSize: 11, padding: '3px 10px', cursor: 'pointer',
};
const cpuLvBtn: React.CSSProperties = {
  background: 'rgba(20,40,80,0.8)', border: '1px solid #4a78c8',
  borderRadius: 6, color: '#a0d0ff', fontSize: 12, padding: '4px 8px', cursor: 'pointer',
};
