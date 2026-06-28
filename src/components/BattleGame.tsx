'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { MONSTERS, MAX_LEVEL } from '@/lib/monsters';
import { buildSprite, rrect, hexA, type Sprite } from '@/lib/sprites';
import { drawMonster, drawOre, evoName } from '@/lib/draw';
import { LocalBoard, type MergeFx } from '@/lib/battle/board';
import { CpuController } from '@/lib/battle/cpu';
import { BattleNet } from '@/lib/battle/net';
import {
  BW, B_H, B_GL, B_GR, B_CX, B_CEILING_Y, B_FLOOR_Y, B_DROP_Y, B_WALL,
  SNAPSHOT_INTERVAL, FORCE_CPU_MS, MAX_PLAYERS, MATCH_DURATION_MS, placeLabel, clientId, battleScore,
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
interface ResultRow {
  id: string; name: string; isSelf: boolean; place: number;
  score: number; combo: number; level: number; bscore: number; alive: boolean;
}

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
  const [results, setResults] = useState<ResultRow[]>([]);
  const [notice, setNotice] = useState<string | null>(null);   // transient banner (e.g. disconnects)
  const [confirmExit, setConfirmExit] = useState(false);       // "back to TOP" confirm during a match
  const noticeTimerRef = useRef<number>(0);
  const takenOverRef = useRef<Set<string>>(new Set());         // human ids converted to CPU on disconnect

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
  const physAccumRef = useRef(0);   // physics throttle accumulator
  const prevDimRef = useRef({ cw: 0, ch: 0, order: '' }); // rect cache key
  const matchEndRef = useRef(0);      // wall-clock ms when the match ends
  const resultsDoneRef = useRef(false);
  const matchLeftRef = useRef(0);     // cached remaining seconds (avoid re-render spam)
  const connectedRef = useRef(false); // net connected once; persists across phases
  const matterRef = useRef<typeof import('matter-js') | null>(null);
  const bgmRef = useRef<HTMLAudioElement | null>(null); // battle BGM
  const seGattaiRef = useRef<HTMLAudioElement | null>(null);       // merge SE
  const seShiranaihitoRef = useRef<HTMLAudioElement | null>(null); // special-merge SE
  const seFallRef = useRef<HTMLAudioElement | null>(null);         // block-falling SE

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

  // ── Battle BGM: play during the countdown + match, stop otherwise. A
  //    document-level gesture listener resumes playback if the browser blocked
  //    the initial play() (autoplay policy) — same recovery as the solo game. ──
  useEffect(() => {
    const bgm = new Audio('/bgm/battle.mp3');
    bgm.loop = true;
    bgm.volume = 0.4;
    bgmRef.current = bgm;
    return () => { bgm.pause(); bgmRef.current = null; };
  }, []);

  // ── Merge SE (same assets as the solo game). Played for YOUR own board's
  //    merges only, so CPU/opponent merges don't spam sound. ──
  useEffect(() => {
    const se = new Audio('/se/gattai.wav'); se.volume = 0.7; seGattaiRef.current = se;
    const seS = new Audio('/se/shiranaihito.wav'); seS.volume = 0.8; seShiranaihitoRef.current = seS;
    const seF = new Audio('/se/fall.mp3'); seF.volume = 0.5; seFallRef.current = seF;
    return () => { seF.pause(); };
  }, []);
  const playSe = useCallback((special: boolean) => {
    const el = special ? seShiranaihitoRef.current : seGattaiRef.current;
    if (!el) return;
    try { const c = el.cloneNode() as HTMLAudioElement; c.volume = el.volume; c.play().catch(() => {}); } catch { /* */ }
  }, []);
  // Falling SE for your own block: start on drop, cut on first landing.
  const playFall = useCallback(() => {
    const f = seFallRef.current; if (!f) return;
    try { f.currentTime = 0; f.play().catch(() => {}); } catch { /* */ }
  }, []);
  const stopFall = useCallback(() => {
    const f = seFallRef.current; if (!f) return;
    try { f.pause(); f.currentTime = 0; } catch { /* */ }
  }, []);

  useEffect(() => {
    const bgm = bgmRef.current;
    if (!bgm) return;
    const playing = phase === 'countdown' || phase === 'playing';
    if (playing) { bgm.play().catch(() => {}); }
    else { bgm.pause(); stopFall(); if (phase !== 'result') bgm.currentTime = 0; }
    const recover = () => {
      if ((phaseRef.current === 'countdown' || phaseRef.current === 'playing') && bgm.paused) {
        bgm.play().catch(() => {});
      }
    };
    document.addEventListener('pointerdown', recover, true);
    return () => document.removeEventListener('pointerdown', recover, true);
  }, [phase, stopFall]);

  // ── Orientation detection ──
  // 縦・横どちらでもプレイ可能。検出結果は背景画像の出し分けにのみ使う
  // （横画面の強制は廃止）。
  useEffect(() => {
    const check = () => {
      setIsLandscape(window.innerWidth >= window.innerHeight);
    };
    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
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

  // ── Finalize: rank by TOTAL battle score ───────────────────
  // Survival alone no longer wins — score = 合体点 + 連鎖 + 最大進化
  // (+ 生存ボーナス). The match ends when everyone is out OR time is up.
  const finalize = useCallback(() => {
    if (resultsDoneRef.current) return;
    if (orderRef.current.length === 0) return;
    resultsDoneRef.current = true;
    const rows: ResultRow[] = orderRef.current.map((id) => {
      const lb = boardsRef.current.get(id);
      const sn = snapsRef.current.get(id);
      const score = lb ? lb.score : (sn?.score ?? 0);
      const combo = lb ? lb.maxCombo : (sn?.mc ?? 0);
      const level = lb ? lb.maxLevel : (sn?.ml ?? 0);
      const dead = lb ? lb.dead : !!sn?.dead;
      return {
        id, name: namesRef.current.get(id) ?? id, isSelf: id === selfId,
        score, combo, level, alive: !dead,
        bscore: battleScore(score, combo, level, !dead), place: 0,
      };
    });
    rows.sort((a, b) => b.bscore - a.bscore);
    rows.forEach((r, i) => { r.place = i + 1; });
    setResults(rows);
    setPhaseBoth('result');
  }, [selfId]);

  // A board I simulate just died → push an immediate snapshot so others
  // see the dead state without waiting for the next tick.
  const onBoardDead = useCallback((id: string) => {
    const b = boardsRef.current.get(id);
    if (b && !offlineRef.current) netRef.current?.sendSnapshot(b.serialize(id));
  }, []);

  // Show a transient banner (e.g. "Xさんの接続がきれました"), auto-hides.
  const showNotice = useCallback((text: string) => {
    setNotice(text);
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 3600);
  }, []);

  // Merge feedback for a board I simulate: burst FX + (own board only) SE.
  const onMergeFx = useCallback((id: string, fx: MergeFx) => {
    burstRef.current.push({
      id, x: fx.x, y: fx.y, start: Date.now(),
      color: fx.level >= MAX_LEVEL ? '#c8a0ff' : MONSTERS[fx.level].glowColor,
      big: fx.big,
    });
    if (id === selfId) playSe(fx.level >= MAX_LEVEL);
  }, [selfId, playSe]);

  // Create a board I simulate (my own, a CPU, or a disconnected human taken
  // over as a CPU). Passing a cpuLevel also attaches a CPU controller.
  const createBoard = useCallback((id: string, seed: number, cpuLevel?: CpuLevel) => {
    const M = matterRef.current;
    if (!M) return null;
    const b = new LocalBoard(M, procRef.current, {
      onAttack: (c) => routeAttack(id, c),
      onMerge: (fx) => onMergeFx(id, fx),
      onDead: () => onBoardDead(id),
      // falling SE only for your own board
      onDrop: id === selfId ? playFall : undefined,
      onLand: id === selfId ? stopFall : undefined,
    }, seed);
    boardsRef.current.set(id, b);
    if (cpuLevel) cpusRef.current.set(id, new CpuController(b, cpuLevel, seed + 104729));
    return b;
  }, [routeAttack, onMergeFx, onBoardDead, selfId, playFall, stopFall]);

  // ── Begin the match (shared by owner + members) ────────────
  const beginGame = useCallback(async (order: string[], seed: number) => {
    const M = matterRef.current ?? (await import('matter-js'));
    matterRef.current = M;
    orderRef.current = order;
    placementsRef.current.clear();
    takenOverRef.current.clear();
    resultsDoneRef.current = false;
    snapsRef.current.clear();
    flyRef.current = [];
    burstRef.current = [];
    boardsRef.current.forEach((b) => b.destroy());
    boardsRef.current.clear();
    cpusRef.current.clear();

    // My own human board.
    createBoard(selfId, seed);

    // Host simulates every CPU board.
    if (isOwnerRef.current) {
      order.forEach((id, i) => {
        if (!id.startsWith('cpu_')) return;
        const level = (room.cpus.find((c) => `cpu_${c.index}` === id)?.level ?? 3) as CpuLevel;
        createBoard(id, seed + i * 7919, level);
      });
    }

    setCount(3);
    setPhaseBoth('countdown');
  }, [room.cpus, selfId, createBoard]);

  // ── Detect human disconnects during a match: notify everyone, and (host)
  //    take over the dropped player's board as a CPU Lv5 so the match goes on.
  //    Also ensures a newly-promoted host simulates every board it should. ──
  const checkDisconnects = useCallback((humans: PresenceState[]) => {
    if (offlineRef.current) return;
    const ph = phaseRef.current;
    if (ph !== 'playing' && ph !== 'countdown') return;
    const present = new Set(humans.map((h) => h.id));
    for (const id of orderRef.current) {
      if (id === selfId || id.startsWith('cpu_') || takenOverRef.current.has(id)) continue;
      if (!present.has(id)) {
        takenOverRef.current.add(id);
        showNotice(`${(namesRef.current.get(id) ?? '相手').slice(0, 10)}さんの接続がきれました`);
      }
    }
    // Host (incl. a freshly-promoted one) must simulate every CPU board and
    // every taken-over human it isn't already simulating.
    if (isOwnerRef.current && matterRef.current) {
      orderRef.current.forEach((id, i) => {
        if (id === selfId || boardsRef.current.has(id)) return;
        const isCpu = id.startsWith('cpu_');
        if (!isCpu && !takenOverRef.current.has(id)) return; // human still connected
        const level = isCpu
          ? ((room.cpus.find((c) => `cpu_${c.index}` === id)?.level ?? 3) as CpuLevel)
          : (5 as CpuLevel);
        createBoard(id, (room.seed ?? 1) + i * 7919, level);
      });
    }
  }, [selfId, room.cpus, room.seed, showNotice, createBoard]);

  // Keep the latest game handlers in a ref so the networking effect can
  // run ONCE per lobby session without re-subscribing every time these
  // callbacks are recreated (which would tear down & reset the room).
  const handlersRef = useRef({ beginGame, checkDisconnects });
  handlersRef.current = { beginGame, checkDisconnects };

  // ── Networking setup — connect ONCE, keep the connection alive for the
  //    whole battle session (lobby → countdown → playing → result). It is
  //    only torn down on unmount, NOT on phase changes. (Tearing it down
  //    on phase change previously killed the channel right at game start.)
  useEffect(() => {
    if (phase !== 'lobby' || connectedRef.current) return;
    connectedRef.current = true;
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
        setHumans(hs);
        setRoom(rm);
        isOwnerRef.current = (hs[0]?.id === selfId);
        hs.forEach((h) => namesRef.current.set(h.id, h.name));
        rm.cpus.forEach((c) => namesRef.current.set(`cpu_${c.index}`, c.name));
        // During a match this also fires on presence changes → detect drops.
        handlersRef.current.checkDisconnects?.(hs);
      },
      onStart: (msg) => {
        msg.order.forEach((id) => { if (!namesRef.current.has(id)) namesRef.current.set(id, id); });
        handlersRef.current.beginGame(msg.order, msg.seed);
      },
      onSnapshot: (msg) => { snapsRef.current.set(msg.id, msg); },
      onAttack: (msg) => {
        const lb = boardsRef.current.get(msg.to);
        if (lb) { lb.receiveOre(msg.count); }
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
    // No cleanup here — the connection must survive phase changes. It is
    // released by the unmount effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ── Owner: 1-minute force-CPU auto start ───────────────────
  useEffect(() => {
    if (phase !== 'lobby' || !isOwnerRef.current || offlineRef.current) return;
    const t = setTimeout(() => {
      if (phaseRef.current !== 'lobby') return;
      // fill empty slots with CPU Lv3 (ensuring >=2 participants), then start
      const cpus = room.cpus.slice();
      while (humans.length + cpus.length < MAX_PLAYERS) {
        const used = new Set(cpus.map((c) => c.index));
        let idx = 0; while (used.has(idx)) idx++;
        cpus.push({ index: idx, level: 3 as CpuLevel, name: 'CPU Lv3' });
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
  // Add a CPU using the lowest free unique id (NOT the slot position, which
  // shifts as humans join/leave and used to collide → overwrite an existing
  // CPU instead of adding a new one).
  const addCpu = (level: CpuLevel) => {
    if (participantCount >= MAX_PLAYERS) return;
    const used = new Set(room.cpus.map((c) => c.index));
    let idx = 0; while (used.has(idx)) idx++;
    applyCpus([...room.cpus, { index: idx, level, name: `CPU Lv${level}` }]);
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
      if (n <= 0) {
        clearInterval(iv);
        matchEndRef.current = Date.now() + MATCH_DURATION_MS;
        setPhaseBoth('playing');
      } else setCount(n);
    }, 800);
    return () => clearInterval(iv);
  }, [phase]);

  // ── Layout ─────────────────────────────────────────────────
  //  縦画面: 自分の盤面を上に大きく、相手はその下に横一列で並べる。
  //  横画面: 自分の盤面を左に大きく、相手は右に縦一列で並べる。
  //  どちらも自分の盤面を最大化し、相手はコンパクトに収める。
  const computeRects = useCallback((cw: number, ch: number) => {
    const order = orderRef.current;
    const opp = order.filter((id) => id !== selfId);
    const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
    const pad = 8, gap = 8, PLATE = 24;
    // Extra headroom at the top so boards sit below the timer / exit controls.
    const padTop = Math.round(Math.max(48, ch * 0.06));
    const availH = ch - padTop - pad;
    const portrait = ch >= cw;

    // Largest board (w,h) fitting a box of (boxW, boxH) minus the score plate,
    // keeping the board aspect. Portrait boards are normally height-bound.
    const fitSize = (boxW: number, boxH: number) => {
      const h0 = Math.max(40, boxH - PLATE);
      let h = h0, w = h * BOARD_ASPECT;
      if (w > boxW) { w = boxW; h = w / BOARD_ASPECT; }
      return { w, h };
    };

    if (opp.length === 0) {
      const { w, h } = fitSize(cw - pad * 2, availH);
      rects.set(selfId, { x: (cw - w) / 2, y: padTop + (availH - PLATE - h) / 2, w, h });
      return rects;
    }

    const n = opp.length;

    if (portrait) {
      // 相手は下段に横一列。各相手は画面幅を均等割りした幅に収める。
      // 相手段の高さは画面の約26%（最小値を確保）。
      const oppRowH = Math.min(availH * 0.30, Math.max(120, availH * 0.24));
      const oppCellW = (cw - pad * 2 - gap * (n - 1)) / n;
      const oppSize = fitSize(oppCellW, oppRowH);

      // 自分は上段の残り高さ全部を使う。
      const selfBoxH = availH - oppRowH - gap;
      const selfSize = fitSize(cw - pad * 2, selfBoxH);
      rects.set(selfId, {
        x: (cw - selfSize.w) / 2,
        y: padTop + (selfBoxH - PLATE - selfSize.h) / 2,
        w: selfSize.w, h: selfSize.h,
      });

      // 相手段を中央寄せで横並び。
      const rowW = oppSize.w * n + gap * (n - 1);
      const rowX0 = (cw - rowW) / 2;
      const rowY0 = padTop + selfBoxH + gap;
      opp.forEach((id, i) => {
        rects.set(id, {
          x: rowX0 + i * (oppSize.w + gap),
          y: rowY0 + (oppRowH - PLATE - oppSize.h) / 2,
          w: oppSize.w, h: oppSize.h,
        });
      });
      return rects;
    }

    // 横画面: 相手は右側に縦一列。
    const cellH = (availH - gap * (n - 1)) / n;
    const oppSize = fitSize(cw, cellH);            // height-bound → narrow column
    const oppColW = oppSize.w;

    const selfSize = fitSize(cw - pad * 2 - gap - oppColW, availH);
    const groupW = selfSize.w + gap + oppColW;
    const x0 = Math.max(pad, (cw - groupW) / 2);
    rects.set(selfId, {
      x: x0,
      y: padTop + (availH - PLATE - selfSize.h) / 2,
      w: selfSize.w, h: selfSize.h,
    });

    const oppX = x0 + selfSize.w + gap;
    opp.forEach((id, i) => {
      const cy = padTop + i * (cellH + gap);
      rects.set(id, {
        x: oppX + (oppColW - oppSize.w) / 2,
        y: cy + (cellH - PLATE - oppSize.h) / 2,
        w: oppSize.w, h: oppSize.h,
      });
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

    // Background — full gradients for self board, solid fills for opponents
    if (isSelf) {
      const veil = ctx.createLinearGradient(0, 0, 0, B_FLOOR_Y);
      veil.addColorStop(0,   'rgba(12,12,40,0.80)');
      veil.addColorStop(0.5, 'rgba(7,7,30,0.84)');
      veil.addColorStop(1,   'rgba(4,4,18,0.90)');
      ctx.fillStyle = veil;
      ctx.fillRect(0, 0, BW, B_H);
      const topG = ctx.createRadialGradient(BW / 2, B_CEILING_Y - 6, 6, BW / 2, B_CEILING_Y - 6, BW * 0.72);
      topG.addColorStop(0, hexA('#6c78ff', 0.12));
      topG.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = topG;
      ctx.fillRect(0, 0, BW, B_FLOOR_Y);
      const wlg = ctx.createLinearGradient(0, 0, B_WALL, 0);
      wlg.addColorStop(0, '#060618'); wlg.addColorStop(1, '#13133c');
      ctx.fillStyle = wlg; ctx.fillRect(0, 0, B_WALL, B_H);
      const wrg = ctx.createLinearGradient(B_GR, 0, B_GR + B_WALL, 0);
      wrg.addColorStop(0, '#13133c'); wrg.addColorStop(1, '#060618');
      ctx.fillStyle = wrg; ctx.fillRect(B_GR, 0, B_WALL, B_H);
      const wfg = ctx.createLinearGradient(0, B_FLOOR_Y, 0, B_H);
      wfg.addColorStop(0, '#13133c'); wfg.addColorStop(1, '#060618');
      ctx.fillStyle = wfg; ctx.fillRect(0, B_FLOOR_Y, BW, B_H - B_FLOOR_Y);
      const vcy = (B_CEILING_Y + B_FLOOR_Y) / 2;
      const vg = ctx.createRadialGradient(BW / 2, vcy, 30, BW / 2, vcy, BW * 0.78);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(0.72, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.40)');
      ctx.fillStyle = vg; ctx.fillRect(0, 0, BW, B_FLOOR_Y);
    } else {
      ctx.fillStyle = '#08082a'; ctx.fillRect(0, 0, BW, B_H);
      ctx.fillStyle = '#060618';
      ctx.fillRect(0, 0, B_WALL, B_H);
      ctx.fillRect(B_GR, 0, B_WALL, B_H);
      ctx.fillRect(0, B_FLOOR_Y, BW, B_H - B_FLOOR_Y);
    }

    // frame
    if (isSelf) {
      ctx.save();
      ctx.strokeStyle = '#ffe050'; ctx.lineWidth = 4;
      ctx.shadowColor = '#ffd24a'; ctx.shadowBlur = 12;
      ctx.strokeRect(2, 2, BW - 4, B_H - 4);
      ctx.shadowBlur = 0;
      // gold corner accents
      ctx.lineWidth = 3;
      const cs = 22;
      ctx.beginPath(); ctx.moveTo(2 + cs, 2); ctx.lineTo(2, 2); ctx.lineTo(2, 2 + cs); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(BW - 2 - cs, 2); ctx.lineTo(BW - 2, 2); ctx.lineTo(BW - 2, 2 + cs); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(2 + cs, B_H - 2); ctx.lineTo(2, B_H - 2); ctx.lineTo(2, B_H - 2 - cs); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(BW - 2 - cs, B_H - 2); ctx.lineTo(BW - 2, B_H - 2); ctx.lineTo(BW - 2, B_H - 2 - cs); ctx.stroke();
      ctx.restore();
    } else {
      ctx.strokeStyle = '#2a1e60'; ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, BW - 2, B_H - 2);
    }

    // danger line
    ctx.save();
    ctx.strokeStyle = 'rgba(255,48,48,0.85)';
    ctx.lineWidth = 1.5;
    if (isSelf) { ctx.shadowColor = 'rgba(255,40,40,0.6)'; ctx.shadowBlur = 6; }
    ctx.setLineDash([7, 5]);
    ctx.beginPath(); ctx.moveTo(B_GL, B_CEILING_Y); ctx.lineTo(B_GR, B_CEILING_Y); ctx.stroke();
    ctx.restore();

    // contents
    const lb = boardsRef.current.get(id);
    let cur = 0, next = 1, dropX = BW / 2, pending = 0, score = 0, dead = false;
    if (lb) {
      lb.forEachBody((level, x, y, angle, sq, merging) => {
        if (level < 0) drawOre(ctx, x, y, 13, Math.round(x), { lite: !isSelf });
        else drawMonster(ctx, x, y, level, procRef.current, { angle, squash: sq, alpha: merging ? 0.5 : 1, lite: !isSelf });
      });
      cur = lb.currentLevel; next = lb.nextLevel; dropX = lb.dropX;
      pending = lb.pendingOre; score = lb.score; dead = lb.dead;
    } else {
      const sn = snapsRef.current.get(id);
      if (sn) {
        for (let i = 0; i + 1 < sn.o.length; i += 2) drawOre(ctx, sn.o[i], sn.o[i + 1], 13, sn.o[i], { lite: true });
        for (let i = 0; i + 3 < sn.b.length; i += 4) {
          drawMonster(ctx, sn.b[i + 1], sn.b[i + 2], sn.b[i], procRef.current, { angle: sn.b[i + 3] / 100, lite: true });
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
    ctx.globalAlpha = 0.95;
    {
      const ng = ctx.createLinearGradient(0, 6, 0, 36);
      ng.addColorStop(0, 'rgba(28,24,60,0.82)'); ng.addColorStop(1, 'rgba(4,4,18,0.82)');
      ctx.fillStyle = ng;
      rrect(ctx, B_GR - 60, 6, 54, 30, 6); ctx.fill();
      ctx.strokeStyle = hexA('#c8a030', 0.6); ctx.lineWidth = 1;
      rrect(ctx, B_GR - 60, 6, 54, 30, 6); ctx.stroke();
      ctx.fillStyle = '#c8a030'; rrect(ctx, B_GR - 60, 6, 54, 2.5, 2); ctx.fill();
    }
    ctx.fillStyle = '#ffe050'; ctx.font = 'bold 9px "Noto Sans JP"'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('NEXT', B_GR - 56, 10);
    ctx.save(); ctx.translate(B_GR - 22, 23); ctx.scale(0.5, 0.5);
    drawMonster(ctx, 0, 0, next, procRef.current, { alpha: 0.95 });
    ctx.restore();
    ctx.restore();

    // pending-ore waiting area indicator (top-left)
    if (pending > 0) {
      ctx.save();
      const pg = ctx.createLinearGradient(0, 6, 0, 32);
      pg.addColorStop(0, 'rgba(96,36,150,0.9)'); pg.addColorStop(1, 'rgba(40,12,70,0.9)');
      ctx.fillStyle = pg;
      rrect(ctx, 8, 6, 70, 26, 6); ctx.fill();
      ctx.strokeStyle = 'rgba(200,140,255,0.7)'; ctx.lineWidth = 1;
      rrect(ctx, 8, 6, 70, 26, 6); ctx.stroke();
      drawOre(ctx, 22, 19, 9, 1);
      ctx.fillStyle = '#f0d860'; ctx.font = 'bold 14px "Oswald", sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
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
    const pty = rect.y + rect.h + 2;
    ctx.save();
    const plg = ctx.createLinearGradient(0, pty, 0, pty + plateH);
    if (isSelf) { plg.addColorStop(0, 'rgba(96,72,8,0.92)'); plg.addColorStop(1, 'rgba(40,28,0,0.92)'); }
    else { plg.addColorStop(0, 'rgba(24,24,52,0.9)'); plg.addColorStop(1, 'rgba(6,6,22,0.9)'); }
    ctx.fillStyle = plg;
    rrect(ctx, rect.x, pty, rect.w, plateH, 5); ctx.fill();
    // top sheen
    ctx.save();
    rrect(ctx, rect.x, pty, rect.w, plateH, 5); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(rect.x, pty + 1, rect.w, 5);
    ctx.restore();
    ctx.strokeStyle = isSelf ? '#ffe050' : '#3a3a60'; ctx.lineWidth = 1;
    rrect(ctx, rect.x, pty, rect.w, plateH, 5); ctx.stroke();
    if (isSelf) { ctx.shadowColor = '#ffd24a'; ctx.shadowBlur = 8; rrect(ctx, rect.x, pty, rect.w, plateH, 5); ctx.stroke(); ctx.shadowBlur = 0; }
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
      // Recompute layout only when canvas size or player list changes
      const orderKey = orderRef.current.join(',');
      if (cw !== prevDimRef.current.cw || ch !== prevDimRef.current.ch || orderKey !== prevDimRef.current.order) {
        rectsRef.current = computeRects(cw, ch);
        prevDimRef.current = { cw, ch, order: orderKey };
      }
      const rects = rectsRef.current;

      if (phaseRef.current === 'playing') {
        // Physics throttled to ~30 fps to reduce mobile CPU load
        physAccumRef.current += dt;
        if (physAccumRef.current >= 33) {
          const stepDt = physAccumRef.current;
          physAccumRef.current = 0;
          if (isOwnerRef.current) cpusRef.current.forEach((c) => c.think());
          boardsRef.current.forEach((b) => { b.step(stepDt); });
        }

        // broadcast snapshots
        if (ts - lastSnapRef.current > SNAPSHOT_INTERVAL) {
          lastSnapRef.current = ts;
          const net = netRef.current;
          if (net && !offlineRef.current) {
            boardsRef.current.forEach((b, id) => net.sendSnapshot(b.serialize(id)));
          }
        }

        // Match-end: everyone out OR time up → rank by total score.
        const now = Date.now();
        matchLeftRef.current = Math.max(0, Math.ceil((matchEndRef.current - now) / 1000));
        const order = orderRef.current;
        const allOut = order.length > 0 && order.every((id) => !alive(id));
        if (!resultsDoneRef.current && (now >= matchEndRef.current || allOut)) finalize();
      }

      // render
      ctx.clearRect(0, 0, cw, ch);

      orderRef.current.forEach((id) => {
        const rect = rects.get(id);
        if (rect) drawBoard(ctx, id, rect, id === selfId);
      });

      drawFx(ctx);

      // Remaining-time badge (top center) ─ (debug HUD removed)
      if (phaseRef.current === 'playing') {
        const m = Math.floor(matchLeftRef.current / 60), sgs = matchLeftRef.current % 60;
        const label = `${m}:${String(sgs).padStart(2, '0')}`;
        const urgent = matchLeftRef.current <= 15;
        ctx.save();
        const bg = ctx.createLinearGradient(0, 6, 0, 32);
        bg.addColorStop(0, 'rgba(20,18,44,0.9)'); bg.addColorStop(1, 'rgba(5,5,20,0.9)');
        ctx.fillStyle = bg;
        rrect(ctx, cw / 2 - 42, 6, 84, 26, 7); ctx.fill();
        ctx.strokeStyle = urgent ? '#ff5050' : '#c8a030'; ctx.lineWidth = 1.5;
        if (urgent) { ctx.shadowColor = '#ff4040'; ctx.shadowBlur = 10 + 6 * (0.5 + 0.5 * Math.sin(Date.now() * 0.012)); }
        rrect(ctx, cw / 2 - 42, 6, 84, 26, 7); ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#c8a030'; rrect(ctx, cw / 2 - 42, 6, 84, 2.5, 2); ctx.fill();
        ctx.fillStyle = urgent ? '#ff8080' : '#ffe050';
        ctx.font = 'bold 18px "Oswald", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, cw / 2, 21);
        ctx.restore();
      }

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
    // ── Touch (mobile): relative drag-to-aim (a SMALL finger move = a BIG
    //    block move) + release-to-drop. There is no hover on touch, and your
    //    board is only part of a wide multi-board screen, so absolute mapping
    //    would be far too sensitive — hence the amplified relative drag. ──
    const GAIN = 2.6; // board-units moved per screen px of finger travel
    let downX = 0, startDropX = B_CX, downT = 0, moved = false;
    const onDown = (x: number) => {
      const b = boardsRef.current.get(selfId);
      downX = x; startDropX = b ? b.dropX : B_CX; downT = Date.now(); moved = false;
    };
    const onMove = (x: number) => {
      const b = boardsRef.current.get(selfId);
      if (!b || b.dead) return;
      if (Math.abs(x - downX) > 4) moved = true;
      b.moveTo(startDropX + (x - downX) * GAIN);
    };
    const onUp = () => {
      const b = boardsRef.current.get(selfId);
      if (!b || b.dead) return;
      if (!moved && Date.now() - downT < 400) b.drop(); // tap = drop in place
      else if (moved) b.drop();                          // swipe = position then drop
    };

    // ── Mouse (desktop): hover to aim (cursor mapped absolutely over your own
    //    board) + press to drop — same feel as the solo game. (Hover-aiming
    //    only works with a mouse; touch keeps the drag model above.) ──
    const aimMouse = (clientX: number) => {
      const b = boardsRef.current.get(selfId);
      if (!b || b.dead) return;
      const rect = rectsRef.current.get(selfId);
      if (!rect || rect.w <= 0) return;
      const sx = canvas.width / window.innerWidth;        // device-px per CSS-px
      b.moveTo(((clientX * sx) - rect.x) / rect.w * BW);   // → board units (clamped)
    };
    const md = (e: MouseEvent) => { aimMouse(e.clientX); boardsRef.current.get(selfId)?.drop(); };
    const mm = (e: MouseEvent) => aimMouse(e.clientX);

    const ts = (e: TouchEvent) => { e.preventDefault(); onDown(e.touches[0].clientX); };
    const tm = (e: TouchEvent) => { e.preventDefault(); onMove(e.touches[0].clientX); };
    const te = (e: TouchEvent) => { e.preventDefault(); onUp(); };
    canvas.addEventListener('mousedown', md);
    canvas.addEventListener('mousemove', mm);
    canvas.addEventListener('touchstart', ts, { passive: false });
    canvas.addEventListener('touchmove', tm, { passive: false });
    canvas.addEventListener('touchend', te, { passive: false });
    return () => {
      canvas.removeEventListener('mousedown', md);
      canvas.removeEventListener('mousemove', mm);
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
      // Render at device resolution (capped) so boards stay smooth instead of
      // blocky when the layout shrinks each player's board (e.g. 4-player).
      const dpr = Math.min(window.devicePixelRatio || 1, window.innerWidth < 1024 ? 1 : 2);
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
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
    <div style={{
      position: 'fixed', inset: 0, overflow: 'hidden', zIndex: 50,
      background: isLandscape
        ? 'url(/background-landscape.png) center/cover no-repeat, #05050f'
        : 'url(/background.png) center/cover no-repeat, #05050f',
    }}>
      <canvas ref={canvasRef} style={{ display: 'block', touchAction: 'none', position: 'absolute', inset: 0 }} />

      {/* Exit button (always). Confirm if a match is in progress. */}
      <button
        onClick={() => {
          if (phase === 'playing' || phase === 'countdown') setConfirmExit(true);
          else onExit();
        }}
        style={exitBtn}
      >✕ TOPへ</button>

      {/* Transient notice banner (e.g. a disconnect → CPU takeover) */}
      {notice && (
        <div style={{
          position: 'absolute', top: 48, left: '50%', transform: 'translateX(-50%)', zIndex: 35,
          background: 'linear-gradient(180deg, rgba(40,20,70,0.95), rgba(10,6,26,0.95))',
          border: '1.5px solid #c060ff', borderRadius: 10,
          boxShadow: '0 4px 18px rgba(160,60,255,0.45)',
          color: '#f3d2ff', fontSize: 14, fontWeight: 700, padding: '8px 18px',
          fontFamily: '"Noto Sans JP", sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none',
        }}>
          🔌 {notice} → 🤖 CPU Lv5 にきりかえ
        </div>
      )}

      {/* Confirm: back to TOP during a match (score is not recorded) */}
      {confirmExit && (
        <Overlay>
          <Panel title="TOPに戻りますか？">
            <div style={{ fontSize: 13, color: '#f0e0b0', textAlign: 'center', lineHeight: 1.7, marginBottom: 4 }}>
              TOPに戻ると、現在のスコアは<br />記録されません。本当に戻りますか？
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'center' }}>
              <button onClick={() => setConfirmExit(false)} style={secondaryBtn}>いいえ</button>
              <button onClick={onExit} style={primaryBtn}>TOPに戻る</button>
            </div>
          </Panel>
        </Overlay>
      )}

      {/* Entry (orient phase = enter name) */}
      {phase === 'orient' && (
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
      {phase === 'lobby' && (
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
                  border: `1.5px solid ${s.kind === 'empty' ? '#3a3a60' : s.kind === 'cpu' ? '#4a78c8' : '#c8a030'}`,
                  borderRadius: 10, padding: 10, minHeight: 78,
                  background: s.kind === 'empty'
                    ? 'linear-gradient(160deg, rgba(16,16,38,0.6), rgba(6,6,22,0.6))'
                    : 'linear-gradient(160deg, rgba(24,22,52,0.82), rgba(8,8,26,0.82))',
                  boxShadow: s.kind === 'empty' ? 'none' : '0 3px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
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
                            <button key={lv} onClick={() => addCpu(lv as CpuLevel)} style={cpuLvBtn}>Lv{lv}</button>
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
            {!offlineRef.current && (
              <div style={{ fontSize: 11, color: '#9a8a60', textAlign: 'center', marginTop: 6 }}>
                ※この画面で待機していると他のユーザーが自動でルームに入室してきます※
              </div>
            )}
          </Panel>
        </Overlay>
      )}

      {/* Countdown */}
      {phase === 'countdown' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none', background: 'radial-gradient(circle at center, rgba(40,20,80,0.45), rgba(4,4,18,0.78))' }}>
          <div
            key={count}
            style={{
              fontSize: 150, fontWeight: 900, lineHeight: 1,
              fontFamily: '"Oswald", "Noto Serif JP", sans-serif',
              background: 'linear-gradient(180deg,#fff6d0 0%,#ffd24a 45%,#ff8a1e 100%)',
              WebkitBackgroundClip: 'text', backgroundClip: 'text',
              WebkitTextFillColor: 'transparent', color: 'transparent',
              filter: 'drop-shadow(0 0 26px rgba(255,140,0,0.85)) drop-shadow(0 4px 6px rgba(0,0,0,0.6))',
              animation: 'countPop 0.8s ease-out',
            }}
          >
            {count}
          </div>
          <style>{`@keyframes countPop{0%{transform:scale(0.4);opacity:0}30%{transform:scale(1.15);opacity:1}55%{transform:scale(1)}100%{transform:scale(1);opacity:1}}`}</style>
        </div>
      )}

      {/* Result */}
      {phase === 'result' && (
        <Overlay>
          <Panel title="🏆 リザルト（総合スコア）" wide>
            {results.map((r) => {
              const medal = r.place === 1 ? '🥇' : r.place === 2 ? '🥈' : r.place === 3 ? '🥉' : '４';
              return (
                <div key={r.id} style={{
                  padding: '9px 14px', marginBottom: 7, borderRadius: 10,
                  background: r.place === 1
                    ? 'linear-gradient(135deg, rgba(255,210,80,0.28), rgba(120,86,10,0.18))'
                    : 'linear-gradient(135deg, rgba(20,20,46,0.78), rgba(8,8,26,0.78))',
                  border: `1px solid ${r.place === 1 ? '#ffd24a' : '#3a3a60'}`,
                  boxShadow: r.place === 1
                    ? '0 0 18px rgba(255,200,60,0.35), inset 0 1px 0 rgba(255,255,255,0.12)'
                    : 'inset 0 1px 0 rgba(255,255,255,0.05)',
                  color: r.isSelf ? '#fff3c0' : '#e0d8c0',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 16, fontWeight: 700 }}>
                      {medal} {placeLabel(r.place)}　{r.name}{r.isSelf ? '（あなた）' : ''}
                    </span>
                    <span style={{ fontSize: 20, fontWeight: 900, color: '#ffe050', fontFamily: '"Oswald", sans-serif' }}>
                      {r.bscore.toLocaleString()}
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: '#9a8a6a', marginTop: 3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <span>合体 {r.score.toLocaleString()}</span>
                    <span>連鎖 ×{r.combo}</span>
                    <span>最大進化 {evoName(r.level)}</span>
                    <span>{r.alive ? '⛏ 生存ボーナス' : '💀 脱落'}</span>
                  </div>
                </div>
              );
            })}
            <div style={{ fontSize: 10, color: '#6a6a90', textAlign: 'center', marginTop: 4 }}>
              総合スコア＝合体点＋連鎖×{300}＋最大進化×{1000}（＋生存{1500}）
            </div>
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
      position: 'absolute', inset: 0,
      background: 'radial-gradient(circle at center, rgba(20,14,48,0.82), rgba(4,4,18,0.92))',
      backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 20,
      fontFamily: '"Noto Sans JP", sans-serif',
    }}>{children}</div>
  );
}
function Panel({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{
      background: 'linear-gradient(160deg, rgba(22,20,48,0.98), rgba(8,8,26,0.98))',
      border: '1.5px solid #c8a030', borderRadius: 16,
      boxShadow: '0 14px 48px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,224,80,0.14), inset 0 1px 0 rgba(255,255,255,0.07)',
      padding: '22px 26px', width: wide ? 560 : 340, maxWidth: '92vw', maxHeight: '90vh', overflowY: 'auto',
    }}>
      <h2 style={{
        textAlign: 'center', color: '#ffe050', margin: '0 0 16px', fontSize: 20, letterSpacing: 1.5,
        textShadow: '0 0 14px rgba(255,200,60,0.55)',
      }}>{title}</h2>
      <div style={{
        height: 2, margin: '0 0 16px', borderRadius: 2,
        background: 'linear-gradient(90deg, rgba(200,160,48,0), #c8a030, rgba(200,160,48,0))',
      }} />
      {children}
    </div>
  );
}

const exitBtn: React.CSSProperties = {
  position: 'absolute', top: 8, left: 8, zIndex: 30,
  background: 'linear-gradient(180deg, rgba(24,22,52,0.92), rgba(6,6,24,0.92))',
  border: '1.5px solid #c8a030', borderRadius: 8,
  color: '#f0e0b0', fontSize: 12, padding: '6px 12px', cursor: 'pointer',
  fontFamily: '"Noto Sans JP", sans-serif',
  boxShadow: '0 2px 8px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06)',
};
const inputStyle: React.CSSProperties = {
  display: 'block', width: '100%', boxSizing: 'border-box', margin: '6px 0 16px',
  background: 'rgba(0,0,0,0.5)', border: '2px solid #fff', borderRadius: 6,
  color: '#fff', fontSize: 15, fontWeight: 700, textAlign: 'center', padding: '8px', outline: 'none',
};
const primaryBtn: React.CSSProperties = {
  background: 'linear-gradient(180deg,#5a4208,#e8be48 45%,#8a6810)', border: '2px solid #ffe050',
  borderRadius: 9, color: '#3a2800', fontSize: 15, fontWeight: 800, padding: '10px 22px', cursor: 'pointer',
  fontFamily: '"Noto Sans JP", sans-serif', letterSpacing: 0.5,
  boxShadow: '0 4px 14px rgba(255,200,60,0.35), inset 0 1px 0 rgba(255,255,255,0.5)',
  textShadow: '0 1px 0 rgba(255,255,255,0.35)',
};
const secondaryBtn: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(34,32,72,0.9), rgba(10,10,30,0.9))', border: '1.5px solid #c8a030',
  borderRadius: 9, color: '#f0e0b0', fontSize: 14, padding: '10px 18px', cursor: 'pointer',
  fontFamily: '"Noto Sans JP", sans-serif',
  boxShadow: '0 3px 10px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.06)',
};
const smallBtn: React.CSSProperties = {
  marginTop: 6, background: 'linear-gradient(180deg, rgba(60,24,24,0.9), rgba(24,10,10,0.9))', border: '1px solid #7a5050',
  borderRadius: 6, color: '#e0a0a0', fontSize: 11, padding: '3px 10px', cursor: 'pointer',
};
const cpuLvBtn: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(30,56,108,0.9), rgba(14,28,60,0.9))', border: '1px solid #4a78c8',
  borderRadius: 6, color: '#b8dcff', fontSize: 12, fontWeight: 700, padding: '4px 9px', cursor: 'pointer',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
};
