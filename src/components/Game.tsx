'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  MONSTERS,
  getRandomStartLevel,
  MAX_LEVEL,
  SPECIAL_MERGE_SCORE,
} from '@/lib/monsters';
import { rrect, hexA, buildSprite, type Sprite } from '@/lib/sprites';

// ─── Canvas dimensions ─────────────────────────────────────────
const W = 560;
const WALL = 14;
const H = 732;

// Frame zoom: a uniform scale of the whole frame about the canvas centre.
// 1.0 = draw the frame.png exactly into the canvas (complete, undistorted,
// no cropping of the outer decorative border — matches the natural look).
const FRAME_ZOOM = 1.0;
const FZ_CX = W / 2;
const FZ_CY = H / 2;
const zx = (x: number) => FZ_CX + (x - FZ_CX) * FRAME_ZOOM;
const zy = (y: number) => FZ_CY + (y - FZ_CY) * FRAME_ZOOM;

// Play field aligned to the (zoomed) frame.png opening so blocks sit inside the border.
const CEILING_Y = 133;   // frame2.png opening top (canvas px)
const FLOOR_Y   = 648;   // frame2.png: bottom of white area (top of dark plates)
const BHUD_Y = FLOOR_Y + WALL;
const DROP_Y = 110;      // aim piece above danger line
const GL = 41;           // frame2.png opening left
const GR = 521;          // frame2.png opening right
const GW = GR - GL;
const CX = W / 2;
const DROP_COOLDOWN = 550;

// ── Decorative frame skin (overlaid during play) ───────────────
const FRAME_SRC  = '/frame.png';
const FRAME2_SRC = '/frame2_alpha.png'; // white pixels pre-processed to transparent
// HUD anchor points within the (zoomed) frame, as px in the W×H canvas.
const FA = {
  nextX:  zx(0.159 * W), nextY: zy(0.112 * H), nextLabelY: zy(0.055 * H),
  bestX:  zx(0.225 * W), scoreX: zx(0.500 * W), evoX: zx(0.786 * W),
  labelY: zy(0.907 * H), valueY: zy(0.948 * H),
};
// Option-button circles baked into the frame (raw canvas coords; pass through
// zx/zy at use). The icons are drawn ON the canvas and taps are hit-tested in
// the canvas handler — HTML <button>s mis-scaled inside the transformed
// wrapper on mobile (icons drifted outside their circles).
const OPT_EGG   = { x: 380, y: 64 };
const OPT_SND   = { x: 422, y: 64 };
const OPT_PAUSE = { x: 462, y: 64 };
const OPT_R = 17;
const OPT_SND_START = { x: W - 28, y: 30 };

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
  squashT?: number;
  squashAmp?: number;
  mergedAt?: number;  // birth animation start time (set only on merge-spawned bodies)
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
  overLineFrames: number;
  maxLevel: number;
  unknownCount: number;
  mergeCounts: number[];
}

interface RankEntry { name: string; score: number; maxLevel: number; unknown?: number; mergeCounts?: number[]; player_id?: string; }

// Ranking label for an entry's max evolution. Players who reached 知らない人
// get it revealed with the number of times they created it (e.g. 知らない人＋3).
function rankEvoLabel(e: RankEntry): string {
  if (e.maxLevel >= MAX_LEVEL) return (e.unknown != null && e.unknown > 0) ? `知らない人＋${e.unknown}` : '知らない人';
  return MONSTERS[e.maxLevel].name;
}

// Floating score / combo popup
interface Popup { x: number; y: number; text: string; start: number; big: boolean; }
// Merge burst: light orbs flying outward + an expanding flash ring
interface Particle { x: number; y: number; vx: number; vy: number; r: number; start: number; life: number; color: string; star?: boolean; }
interface Ring { x: number; y: number; start: number; life: number; maxR: number; color: string; }
const COMBO_WINDOW = 850; // ms within which merges count as a combo
const COMBO_CAP = 9;      // max combo multiplier / display

const RANK_KEY = 'sporinkaRanking';
const RANK_MAX = 30;

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

const PLAYER_NAME_KEY = 'sporinkaPlayerName';
const PLAYER_ID_KEY   = 'sporinkaPlayerId';

// Random alphanumeric id (upper/lower case + digits)
function randId(len: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
// Default player name, e.g. 「知らない人a9Kp」
function defaultPlayerName(): string {
  return '知らない人' + randId(4);
}

// Fetch the shared online ranking; falls back to the local one on failure.
async function fetchGlobalRanking(): Promise<RankEntry[]> {
  try {
    const res = await fetch('/api/ranking');
    if (!res.ok) throw new Error('bad response');
    const data = await res.json();
    return Array.isArray(data) ? data : loadRanking();
  } catch {
    return loadRanking();
  }
}

// Submit a run to the shared online ranking; falls back to the local
// ranking (and its index) on failure.
async function submitGlobalRanking(entry: RankEntry): Promise<{ list: RankEntry[]; index: number }> {
  try {
    const res = await fetch('/api/ranking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
    if (!res.ok) throw new Error('bad response');
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('bad payload');
    const index = list.findIndex((e: RankEntry) => e.name === entry.name && e.score === entry.score);
    return { list, index };
  } catch {
    return insertRanking(entry);
  }
}

// Display name for an evolution level — the secret monster is masked
function evoName(lvl: number): string {
  return lvl >= MAX_LEVEL ? '？？？' : MONSTERS[lvl].name;
}

// TOP menu button rects
// プレイヤー名ラベル＋入力欄（スタートボタンの上）の領域
const NAME_LABEL_Y   = 338;
const NAME_INPUT_TOP = 348;
const NAME_INPUT_H   = 40;

// Decorative rules
const TITLE_DIV_Y    = 296;  // rich rule in the gap between title and the rest
const NAME_DIV_Y     = 406;  // rule below the player-name input

// All TOP buttons share the same size (h=52 to fit 6 buttons within H=732)
const MENU_START_BTN  = { w: 288, h: 52, x: CX - 144, y: 410 };
const MENU_BATTLE_BTN = { w: 288, h: 52, x: CX - 144, y: 464 };
const MENU_RANK_BTN   = { w: 288, h: 52, x: CX - 144, y: 518 };
const MENU_REPORT_BTN = { w: 288, h: 52, x: CX - 144, y: 572 };
const MENU_SET_BTN    = { w: 288, h: 52, x: CX - 144, y: 626 };
const MENU_HOW_BTN    = { w: 288, h: 52, x: CX - 144, y: 680 };
// In-game / game-over button rects
const GO_BTN = { w: 324, h: 46, x: CX - 162, y: 500 };         // retry (primary, full width)
const GO_TOP_BTN = { w: 102, h: 40, x: CX - 162, y: 558 };     // back to TOP menu
const GO_VIEW_BTN = { w: 102, h: 40, x: CX - 51, y: 558 };     // view final board
const GO_SHOT_BTN = { w: 102, h: 40, x: CX + 60, y: 558 };     // save screenshot
// Buttons shown while gazing at the final board
const GO_BACK_BTN = { w: 112, h: 34, x: 12, y: 10 };
const GO_VSHOT_BTN = { w: 112, h: 34, x: W - 124, y: 10 };

// ═══════════════════════════════════════════════════════════════
export default function Game({ onBattle }: { onBattle?: () => void } = {}) {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const wrapRef       = useRef<HTMLDivElement>(null);
  const engineRef     = useRef<unknown>(null);
  const MRef          = useRef<typeof import('matter-js') | null>(null);
  const bodyDataRef   = useRef<Map<number, BodyData>>(new Map());
  const mergingRef    = useRef<Set<number>>(new Set());
  const rafRef        = useRef<number>(0);
  const scaleRef      = useRef<number>(1);
  const coolRef       = useRef<number>(0);
  // Canvas-space pointer position (for TOP menu hover lighting). -1 = off-canvas.
  const pointerRef    = useRef<{ x: number; y: number }>({ x: -1, y: -1 });
  const imgsRef       = useRef<Map<number, HTMLImageElement>>(new Map());
  const procRef       = useRef<Map<number, Sprite>>(new Map());
  const frameImgRef    = useRef<HTMLImageElement | null>(null);
  const frameReadyRef  = useRef<boolean>(false);
  const frame2ImgRef   = useRef<HTMLImageElement | null>(null);
  const frame2ReadyRef = useRef<boolean>(false);
  const secretFxRef   = useRef<{ start: number; sparkles: { x: number; y: number; r: number; tw: number }[] } | null>(null);
  const rankingRef    = useRef<RankEntry[]>([]);
  const lastRankIdxRef = useRef<number>(-1);
  const playerNameRef = useRef<string>('');
  const playerIdRef   = useRef<string>('');
  const popupsRef     = useRef<Popup[]>([]);
  const particlesRef  = useRef<Particle[]>([]);
  const ringsRef      = useRef<Ring[]>([]);
  const comboRef      = useRef<{ count: number; lastTime: number }>({ count: 0, lastTime: 0 });
  const snapshotRef   = useRef<HTMLCanvasElement | null>(null);
  const viewingRef    = useRef<boolean>(false); // gazing at the final board
  const bgmRef              = useRef<HTMLAudioElement | null>(null); // TOP screen BGM
  const bgmPlayRef          = useRef<HTMLAudioElement | null>(null); // solo play BGM
  const bgmGameoverRef      = useRef<HTMLAudioElement | null>(null);
  const seGattaiRef         = useRef<HTMLAudioElement | null>(null);
  const seShiranaihitoRef   = useRef<HTMLAudioElement | null>(null);
  const seFallRef           = useRef<HTMLAudioElement | null>(null); // block-falling SE
  const fallingIdRef        = useRef<number>(-1);                    // body id currently falling
  const bgmOnRef            = useRef(true);
  const seOnRef             = useRef(true);
  // Web Audio: pre-decoded SE buffers for instant, reliable, overlapping playback
  const audioCtxRef         = useRef<AudioContext | null>(null);
  const seBuffersRef        = useRef<Map<string, AudioBuffer>>(new Map());

  const [bgmOn, setBgmOn]   = useState(true);
  const [seOn,  setSeOn]    = useState(true);
  const [modal, setModal]   = useState<null | 'ranking' | 'settings' | 'howto' | 'confirmTop' | 'report'>(null);
  const modalRef            = useRef<null | 'ranking' | 'settings' | 'howto' | 'confirmTop' | 'report'>(null);
  const [reportName, setReportName]         = useState('');
  const [reportCategory, setReportCategory] = useState('不具合報告');
  const [reportContent, setReportContent]   = useState('');
  const [reportSending, setReportSending]   = useState(false);
  const [reportResult, setReportResult]     = useState('');
  const [isPaused, setIsPaused] = useState(false);
  const isPausedRef         = useRef(false);
  const pausedForModalRef   = useRef(false);
  const [showTutorial, setShowTutorial] = useState(() => {
    try { return !localStorage.getItem('sporinkaFirstPlay'); } catch { return false; }
  });
  const shakeRef   = useRef(0);   // game-over screen shake intensity
  const goStartRef = useRef(0);   // timestamp when game over began (for score countdown)
  const [, setRankingTick]  = useState(0);
  const [playerNameInput, setPlayerNameInput] = useState('');
  const [sysNotif, setSysNotif] = useState<{ title: string; message: string; type: string } | null>(null);
  const notifQueueRef  = useRef<Array<{ title: string; message: string; type: string; display_ms: number }>>([]);
  const notifShowingRef = useRef(false);
  const lastNotifAtRef  = useRef<string>(new Date().toISOString());

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
    unknownCount: 0,
    mergeCounts: new Array(11).fill(0),
  });

  const [uiPhase, setUiPhase] = useState<Phase>('start');

  // Load the decorative frame skins once.
  useEffect(() => {
    const img = new Image();
    img.onload = () => { frameReadyRef.current = true; };
    img.src = FRAME_SRC;
    frameImgRef.current = img;
  }, []);

  useEffect(() => {
    const img = new Image();
    img.onload = () => { frame2ReadyRef.current = true; };
    img.src = FRAME2_SRC;
    frame2ImgRef.current = img;
  }, []);

  // Load the saved player name once on mount; if none, generate a default
  // 「知らない人XXXX」 (random alphanumeric) and persist it.
  useEffect(() => {
    let name = '';
    try { name = localStorage.getItem(PLAYER_NAME_KEY) ?? ''; } catch { /* */ }
    if (!name) {
      name = defaultPlayerName();
      try { localStorage.setItem(PLAYER_NAME_KEY, name); } catch { /* */ }
    }
    playerNameRef.current = name;
    setPlayerNameInput(name);

    let pid = '';
    try { pid = localStorage.getItem(PLAYER_ID_KEY) ?? ''; } catch { /* */ }
    if (!pid) {
      pid = randId(16);
      try { localStorage.setItem(PLAYER_ID_KEY, pid); } catch { /* */ }
    }
    playerIdRef.current = pid;
  }, []);

  // Load the shared ranking once on mount (online only; localStorage is fallback on error)
  useEffect(() => {
    fetchGlobalRanking().then((list) => {
      rankingRef.current = list;
      setRankingTick((t) => t + 1);
    });
  }, []);

  // Adminアナウンスを20秒ごとにポーリング
  useEffect(() => {
    const showNext = () => {
      if (notifShowingRef.current) return;
      const next = notifQueueRef.current.shift();
      if (!next) return;
      notifShowingRef.current = true;
      setSysNotif({ title: next.title, message: next.message, type: next.type });
      setTimeout(() => {
        setSysNotif(null);
        notifShowingRef.current = false;
        setTimeout(showNext, 400);
      }, next.display_ms);
    };

    const poll = async () => {
      try {
        const res = await fetch(`/api/notifications?since=${encodeURIComponent(lastNotifAtRef.current)}`);
        if (!res.ok) return;
        const { data } = await res.json() as { data: Array<{ title: string; message: string; type: string; display_ms: number; created_at: string }> };
        if (!Array.isArray(data) || data.length === 0) return;
        lastNotifAtRef.current = data[data.length - 1].created_at;
        for (const n of data) {
          notifQueueRef.current.push({
            title: String(n.title || ''),
            message: String(n.message || ''),
            type: String(n.type || 'system'),
            display_ms: Math.max(2000, Math.min(30000, Number(n.display_ms) || 4000)),
          });
        }
        showNext();
      } catch { /* offline時無視 */ }
    };

    poll();
    const id = setInterval(poll, 20_000);
    return () => clearInterval(id);
  }, []);

  // 60秒ごとにオンライン心拍を送信（Adminのオンライン人数表示用）
  useEffect(() => {
    const sendHeartbeat = () => {
      const pid = playerIdRef.current;
      if (!pid) return;
      fetch('/api/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          player_id: pid,
          player_name: (playerNameRef.current.trim() || 'ぼうけんしゃ').slice(0, 30),
          floor: gs.current.maxLevel,
        }),
      }).catch(() => {/* offline時は無視 */});
    };
    sendHeartbeat();
    const id = setInterval(sendHeartbeat, 60_000);
    return () => clearInterval(id);
  }, []);

  // Load audio assets
  useEffect(() => {
    const bgm = new Audio('/bgm/top.mp3');
    bgm.loop = true;
    bgm.volume = 0.4;
    bgmRef.current = bgm;
    const bgmPlay = new Audio('/bgm/single.mp3'); // solo gameplay BGM
    bgmPlay.loop = true;
    bgmPlay.volume = 0.4;
    bgmPlayRef.current = bgmPlay;
    const bgmGO = new Audio('/bgm/gameover.mp3');
    bgmGO.loop = false;
    bgmGO.volume = 0.5;
    bgmGameoverRef.current = bgmGO;
    // HTMLAudio fallback (used only if Web Audio is unavailable)
    const se = new Audio('/se/gattai.wav');
    se.volume = 0.7;
    seGattaiRef.current = se;
    const seS = new Audio('/se/shiranaihito.wav');
    seS.volume = 0.8;
    seShiranaihitoRef.current = seS;
    const seFall = new Audio('/se/fall.mp3'); // plays while a block is falling
    seFall.volume = 0.5;
    seFallRef.current = seFall;

    // Web Audio: create the context and pre-decode every SE into a buffer
    // so playback is instant, overlappable and never fails mid-game.
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) {
      try {
        const ctx = new AC();
        audioCtxRef.current = ctx;
        const decode = async (src: string) => {
          try {
            const res = await fetch(src);
            const buf = await res.arrayBuffer();
            const audioBuf = await ctx.decodeAudioData(buf);
            seBuffersRef.current.set(src, audioBuf);
          } catch { /* leave it to the HTMLAudio fallback */ }
        };
        decode('/se/gattai.wav');
        decode('/se/shiranaihito.wav');
      } catch { /* no Web Audio → HTMLAudio fallback */ }
    }

    return () => {
      bgm.pause();
      bgmPlay.pause();
      bgmGO.pause();
      seFall.pause();
      audioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  // Resume the Web Audio context — must run inside a user gesture (browser
  // autoplay policy). Safe to call repeatedly.
  const unlockAudio = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }, []);

  // Falling SE: start when a block is dropped, cut the moment it lands.
  const playFall = useCallback(() => {
    if (!seOnRef.current) return;
    const f = seFallRef.current;
    if (!f) return;
    try { f.currentTime = 0; f.play().catch(() => {}); } catch { /* */ }
  }, []);
  const stopFall = useCallback(() => {
    const f = seFallRef.current;
    if (!f) return;
    try { f.pause(); f.currentTime = 0; } catch { /* */ }
    fallingIdRef.current = -1;
  }, []);

  // Play a sound effect. Prefers the pre-decoded Web Audio buffer (instant,
  // overlapping); falls back to a cloned HTMLAudio element.
  const playSe = useCallback((src: string, volume: number, fallback: HTMLAudioElement | null, rate = 1) => {
    if (!seOnRef.current) return;
    const ctx = audioCtxRef.current;
    const buf = seBuffersRef.current.get(src);
    if (ctx && buf) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      try {
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.playbackRate.value = rate;
        const gain = ctx.createGain();
        gain.gain.value = volume;
        node.connect(gain).connect(ctx.destination);
        node.start();
        return;
      } catch { /* fall through to HTMLAudio */ }
    }
    if (fallback) {
      try {
        const clone = fallback.cloneNode() as HTMLAudioElement;
        clone.volume = Math.min(volume, 1);
        clone.playbackRate = rate;
        clone.play().catch(() => {});
      } catch { /* */ }
    }
  }, []);

  // Combo-scaled merge SE: the higher the combo, the richer the sound —
  // louder, pitched up, and layered into an ascending sparkly cascade.
  const playComboMerge = useCallback((combo: number) => {
    const vol = Math.min(0.7 + (combo - 1) * 0.04, 1);
    playSe('/se/gattai.wav', vol, seGattaiRef.current, 1 + (combo - 1) * 0.05);
    if (combo >= 3) window.setTimeout(() => playSe('/se/gattai.wav', vol * 0.6, seGattaiRef.current, 1.33), 70);
    if (combo >= 5) window.setTimeout(() => playSe('/se/gattai.wav', vol * 0.5, seGattaiRef.current, 1.5), 140);
    if (combo >= 7) window.setTimeout(() => playSe('/se/gattai.wav', vol * 0.45, seGattaiRef.current, 2), 210);
  }, [playSe]);

  // ── Play exactly the BGM that matches the current phase (TOP / playing /
  //    gameover), pausing the others. Safe to call any time; only plays when
  //    BGM is on and the game isn't paused. ──────────────────────────────
  const syncBgm = useCallback(() => {
    const top = bgmRef.current, play = bgmPlayRef.current, go = bgmGameoverRef.current;
    const phase = gs.current.phase;
    let target: HTMLAudioElement | null = null;
    if (bgmOnRef.current && !isPausedRef.current) {
      target = phase === 'gameover' ? go : phase === 'playing' ? play : top;
    }
    [top, play, go].forEach((a) => { if (a && a !== target && !a.paused) a.pause(); });
    if (target && target.paused) target.play().catch(() => {});
  }, []);

  useEffect(() => { bgmOnRef.current = bgmOn; syncBgm(); }, [bgmOn, syncBgm]);

  useEffect(() => { seOnRef.current = seOn; }, [seOn]);

  // ── Audio recovery: browsers block audio until a user gesture, and a
  //    play() rejected before the first interaction never retries on its own.
  //    Any pointer/key interaction anywhere resumes the Web Audio context and
  //    (re)starts the phase-appropriate BGM, so audio reliably kicks in on the
  //    user's first click instead of needing a manual sound ON/OFF toggle. ──
  useEffect(() => {
    const recover = () => {
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      syncBgm();
    };
    document.addEventListener('pointerdown', recover, true);
    document.addEventListener('keydown', recover, true);
    return () => {
      document.removeEventListener('pointerdown', recover, true);
      document.removeEventListener('keydown', recover, true);
    };
  }, [syncBgm]);

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
    squash = 0,
    mergedAt = 0, // birth animation: timestamp set on merge-spawned bodies
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
      // birth-spring scale for newly merged bodies (overshoot → settle)
      let bs = 1;
      if (mergedAt) {
        const age = Date.now() - mergedAt;
        if (age < 400) {
          const t = age / 400;
          bs = t < 0.5 ? (t / 0.5) * 1.22 : 1.22 - 0.22 * ((t - 0.5) / 0.5);
        }
      }
      if (squash) ctx.scale((1 + squash) * bs, (1 - squash) * bs);
      else if (bs !== 1) ctx.scale(bs, bs);
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

  // ── Block name text, tinted to the block's colour with a glowing
  //    aura + dark outline so it stays legible on dark panels ──────
  const drawNameText = useCallback((
    ctx: CanvasRenderingContext2D,
    text: string, cx: number, cy: number, level: number, fs: number,
  ) => {
    // bright tint (highlightColor) + matching glow; secret block = mystic purple
    let fill: string, glow: string;
    if (level >= MAX_LEVEL) { fill = '#e8c8ff'; glow = '#b060ff'; }
    else { const m = MONSTERS[level]; fill = m.highlightColor; glow = m.glowColor; }
    ctx.save();
    ctx.font = `bold ${fs}px "Noto Sans JP", sans-serif`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, fs * 0.26);
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.strokeText(text, cx, cy);
    ctx.shadowColor = glow;
    ctx.shadowBlur = fs * 0.85;
    ctx.fillStyle = fill;
    ctx.fillText(text, cx, cy); // double pass intensifies the aura
    ctx.fillText(text, cx, cy);
    ctx.restore();
  }, []);

  // ── Background ──────────────────────────────────────────────
  const drawBG = useCallback((ctx: CanvasRenderingContext2D) => {
    // The background image is rendered full-screen by the page. The canvas
    // stays transparent outside the play field so that image shows through
    // there. Inside the play field we lay a dark veil over it so the blocks
    // stay readable — now with depth: vertical gradient, edge vignette, a
    // soft top light source, a faint grid and slow-drifting light motes.
    const now = Date.now();
    // Veil only inside the play opening (CEILING_Y..FLOOR_Y); the area above
    // (the frame's top arch) stays clear so the background art shows there.
    const top0 = CEILING_Y, bot0 = FLOOR_Y, fh = bot0 - top0;

    // 1. Veil — vertical gradient (lighter at the top, deeper at the floor)
    const veil = ctx.createLinearGradient(0, top0, 0, bot0);
    veil.addColorStop(0,   'rgba(10,10,38,0.58)');
    veil.addColorStop(0.5, 'rgba(7,7,30,0.66)');
    veil.addColorStop(1,   'rgba(4,4,20,0.74)');
    ctx.fillStyle = veil;
    ctx.fillRect(GL, top0, GW, fh);

    // 2. Soft top light source (mystic glow at the danger line)
    const top = ctx.createRadialGradient(CX, top0, 8, CX, top0, GW * 0.7);
    top.addColorStop(0, hexA('#6c78ff', 0.12));
    top.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = top;
    ctx.fillRect(GL, top0, GW, fh);

    // 3. Faint grid
    ctx.save();
    ctx.beginPath(); ctx.rect(GL, top0, GW, fh); ctx.clip();
    ctx.strokeStyle = 'rgba(40,40,110,0.14)';
    ctx.lineWidth = 1;
    for (let x = GL; x <= GR; x += 40) { ctx.beginPath(); ctx.moveTo(x, top0); ctx.lineTo(x, bot0); ctx.stroke(); }
    for (let y = top0; y <= bot0; y += 40) { ctx.beginPath(); ctx.moveTo(GL, y); ctx.lineTo(GR, y); ctx.stroke(); }
    ctx.restore();

    // 4. Slow-drifting light motes (ambient depth, very subtle)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const N = 16;
    for (let i = 0; i < N; i++) {
      const fx    = 0.5 + 0.5 * Math.sin(i * 12.9898);
      const speed = 8000 + (i % 5) * 2200;
      const phase = ((now / speed) + fx) % 1;
      const x = GL + 12 + fx * (GW - 24) + Math.sin(now / 2200 + i) * 9;
      const y = bot0 - phase * (fh - 6);
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(now * 0.0028 + i * 1.7));
      const r  = (1.1 + (i % 3) * 0.7) * tw;
      const a  = 0.16 * tw * Math.sin(phase * Math.PI);
      if (a <= 0) continue;
      const tint = i % 3 === 0 ? '#c8a0ff' : '#9fb0ff';
      ctx.shadowColor = hexA(tint, a);
      ctx.shadowBlur  = r * 3;
      ctx.fillStyle   = hexA(tint, a);
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // 5. Edge vignette
    const cy = (top0 + bot0) / 2;
    const vg = ctx.createRadialGradient(CX, cy, 40, CX, cy, GW * 0.82);
    vg.addColorStop(0,    'rgba(0,0,0,0)');
    vg.addColorStop(0.72, 'rgba(0,0,0,0)');
    vg.addColorStop(1,    'rgba(0,0,0,0.42)');
    ctx.fillStyle = vg;
    ctx.fillRect(GL, top0, GW, fh);

  }, []);

  // ── Walls ───────────────────────────────────────────────────
  const drawWalls = useCallback((ctx: CanvasRenderingContext2D) => {
    const lg = ctx.createLinearGradient(0, 0, WALL, 0);
    lg.addColorStop(0, '#060618'); lg.addColorStop(1, '#10103a');
    ctx.fillStyle = lg; ctx.fillRect(0, 0, WALL, H);

    const rg = ctx.createLinearGradient(GR, 0, W, 0);
    rg.addColorStop(0, '#10103a'); rg.addColorStop(1, '#060618');
    ctx.fillStyle = rg; ctx.fillRect(GR, 0, WALL, H);

    // Bottom band (floor)
    const fg = ctx.createLinearGradient(0, FLOOR_Y, 0, H);
    fg.addColorStop(0, '#10103a'); fg.addColorStop(1, '#060618');
    ctx.fillStyle = fg; ctx.fillRect(0, FLOOR_Y, W, WALL);

    // Top band (mirrors the floor) so the play field is fully enclosed
    const tg = ctx.createLinearGradient(0, CEILING_Y - WALL, 0, CEILING_Y);
    tg.addColorStop(0, '#060618'); tg.addColorStop(1, '#10103a');
    ctx.fillStyle = tg; ctx.fillRect(0, CEILING_Y - WALL, W, WALL);

    // Outer top/bottom bands so the whole canvas (HUD included) sits
    // inside a closed frame, matching the full-height side walls.
    // Thin (4px) so it sits in the existing margin above/below the HUD
    // panels instead of covering them.
    const OUTER = 4;
    const otg = ctx.createLinearGradient(0, 0, 0, OUTER);
    otg.addColorStop(0, '#10103a'); otg.addColorStop(1, '#060618');
    ctx.fillStyle = otg; ctx.fillRect(0, 0, W, OUTER);

    const obg = ctx.createLinearGradient(0, H - OUTER, 0, H);
    obg.addColorStop(0, '#060618'); obg.addColorStop(1, '#10103a');
    ctx.fillStyle = obg; ctx.fillRect(0, H - OUTER, W, OUTER);

    ctx.strokeStyle = P.wallEdge; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, OUTER); ctx.lineTo(W, OUTER); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, H - OUTER); ctx.lineTo(W, H - OUTER); ctx.stroke();

    // Inner frame edges around the play field (top..floor)
    ctx.strokeStyle = P.wallEdge; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(GL, CEILING_Y); ctx.lineTo(GL, FLOOR_Y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(GR, CEILING_Y); ctx.lineTo(GR, FLOOR_Y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(GL, FLOOR_Y);   ctx.lineTo(GR, FLOOR_Y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(GL, CEILING_Y); ctx.lineTo(GR, CEILING_Y); ctx.stroke();

    // Gold corner accents (all four corners of the play field)
    ctx.strokeStyle = P.gold; ctx.lineWidth = 2;
    const cs = 18;
    ctx.beginPath(); ctx.moveTo(GL+cs,FLOOR_Y);   ctx.lineTo(GL,FLOOR_Y);   ctx.lineTo(GL,FLOOR_Y-cs);   ctx.stroke();
    ctx.beginPath(); ctx.moveTo(GR-cs,FLOOR_Y);   ctx.lineTo(GR,FLOOR_Y);   ctx.lineTo(GR,FLOOR_Y-cs);   ctx.stroke();
    ctx.beginPath(); ctx.moveTo(GL+cs,CEILING_Y); ctx.lineTo(GL,CEILING_Y); ctx.lineTo(GL,CEILING_Y+cs); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(GR-cs,CEILING_Y); ctx.lineTo(GR,CEILING_Y); ctx.lineTo(GR,CEILING_Y+cs); ctx.stroke();

    diamond(ctx, GL, (CEILING_Y + FLOOR_Y) / 2, 5);
    diamond(ctx, GR, (CEILING_Y + FLOOR_Y) / 2, 5);

    // ── Rich gold outer frame (all 4 canvas edges) ──
    ctx.save();
    ctx.strokeStyle = P.gold;
    ctx.lineWidth = 3;
    ctx.shadowColor = P.goldBrt;
    ctx.shadowBlur = 10;
    rrect(ctx, 2.5, 2.5, W - 5, H - 5, 10);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // bright inner hairline for a jeweled look
    ctx.strokeStyle = hexA(P.goldBrt, 0.55);
    ctx.lineWidth = 1;
    rrect(ctx, 6, 6, W - 12, H - 12, 8);
    ctx.stroke();
    // small gold corner diamonds on the frame for extra richness
    [[8, 8], [W - 8, 8], [8, H - 8], [W - 8, H - 8]].forEach(([dx, dy]) => {
      ctx.fillStyle = P.goldBrt;
      ctx.shadowColor = P.goldBrt; ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(dx, dy - 3); ctx.lineTo(dx + 3, dy);
      ctx.lineTo(dx, dy + 3); ctx.lineTo(dx - 3, dy);
      ctx.closePath(); ctx.fill();
    });
    ctx.restore();
  }, [diamond]);

  // ── Ceiling / Danger zone ───────────────────────────────────
  const drawCeiling = useCallback((ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = 'rgba(200,0,0,0.055)';
    ctx.fillRect(GL, 0, GW, CEILING_Y);

    ctx.save();
    // glow layer
    ctx.strokeStyle = 'rgba(255,60,60,0.35)';
    ctx.lineWidth = 6;
    ctx.globalAlpha = 1;
    ctx.setLineDash([7, 5]);
    ctx.beginPath(); ctx.moveTo(GL, CEILING_Y); ctx.lineTo(GR, CEILING_Y); ctx.stroke();
    // solid line on top
    ctx.strokeStyle = P.danger;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.95;
    ctx.beginPath(); ctx.moveTo(GL, CEILING_Y); ctx.lineTo(GR, CEILING_Y); ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = 'bold 11px "Noto Sans JP", sans-serif';
    ctx.fillStyle = P.danger;
    ctx.globalAlpha = 0.95;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.shadowColor = 'rgba(255,0,0,0.7)';
    ctx.shadowBlur = 6;
    ctx.fillText('⚠ DANGER LINE', GL + 28, CEILING_Y - 4);
    ctx.restore();
  }, []);

  // ── HUD ─────────────────────────────────────────────────────
  const drawHUD = useCallback((ctx: CanvasRenderingContext2D, st: GS) => {
    // Even margin (MG) from the gold frame on all sides.
    const MG = 8;
    const py = MG, ph = (CEILING_Y - WALL) - py - MG; // even gap top & above the top band

    // Glassy panel: base fill + vertical depth gradient + top sheen +
    // border + gold top accent. Reused for the NEXT box and the score bar.
    const glassPanel = (x: number, y: number, w: number, h: number, r: number) => {
      ctx.fillStyle = P.panel;
      rrect(ctx, x, y, w, h, r); ctx.fill();
      ctx.save();
      rrect(ctx, x, y, w, h, r); ctx.clip();
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0,   'rgba(70,64,140,0.24)');
      g.addColorStop(0.5, 'rgba(0,0,0,0)');
      g.addColorStop(1,   'rgba(0,0,0,0.30)');
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.06)'; // top sheen
      ctx.fillRect(x, y + 3, w, 6);
      ctx.restore();
      ctx.strokeStyle = P.panelBrd; ctx.lineWidth = 1;
      rrect(ctx, x, y, w, h, r); ctx.stroke();
      ctx.fillStyle = P.gold; rrect(ctx, x, y, w, 3, 3); ctx.fill();
    };

    // ── Top-left: NEXT panel (even margin from the frame) ──
    const nw = 84, nx = MG;
    glassPanel(nx, py, nw, ph, 5);

    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = P.gold;
    ctx.font = 'bold 12px "Noto Sans JP", sans-serif';
    ctx.fillText('NEXT', nx + nw / 2, py + 7);

    const nm  = MONSTERS[st.nextLevel];
    const nmr = Math.min(nm.radius, 28);
    const sc  = nmr / nm.radius;
    const bob = Math.sin(Date.now() * 0.003) * 2.2; // gentle float
    ctx.save();
    ctx.translate(nx + nw / 2, py + ph / 2 + 8 + bob);
    ctx.scale(sc, sc);
    drawMonster(ctx, 0, 0, st.nextLevel, 0.9);
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
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    drawNameText(ctx, nameShort, nx + nw / 2, pillY + pillH / 2 + 0.5, st.nextLevel, 9);

    // ── Current monster at drop position ──
    if (st.phase === 'playing') {
      drawMonster(ctx, st.dropX, DROP_Y, st.currentLevel);
      if (st.canDrop) {
        const r = MONSTERS[st.currentLevel].radius;
        const now = Date.now();
        ctx.save();
        // flowing dashed guide
        ctx.strokeStyle = 'rgba(180,190,255,0.32)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 7]);
        ctx.lineDashOffset = -(now * 0.02) % 12;
        ctx.beginPath();
        ctx.moveTo(st.dropX, DROP_Y + r + 2);
        ctx.lineTo(st.dropX, FLOOR_Y);
        ctx.stroke();
        ctx.setLineDash([]);
        // pulsing landing marker on the floor
        const pulse = 0.5 + 0.5 * Math.sin(now * 0.006);
        ctx.strokeStyle = `rgba(200,210,255,${0.22 + 0.30 * pulse})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(st.dropX, FLOOR_Y - 4, r * 0.55, 5, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ── Bottom HUD bar: BEST | SCORE | 最大進化 (even margin from frame) ──
    const bX = MG, bW = W - 2 * MG;
    const bY = BHUD_Y + MG, bH = H - bY - MG;
    glassPanel(bX, bY, bW, bH, 6);

    // three cells: BEST (left) | SCORE (centre) | 最大進化 (right)
    const w1 = bW * 0.27, w2 = bW * 0.36, w3 = bW - w1 - w2;
    const x1 = bX, x2 = bX + w1, x3 = bX + w1 + w2;

    ctx.strokeStyle = 'rgba(120,100,200,0.3)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x2, bY + 8); ctx.lineTo(x2, bY + bH - 8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x3, bY + 8); ctx.lineTo(x3, bY + bH - 8); ctx.stroke();

    const labelY = bY + 9;
    const valY = bY + bH - 18; // values sit near the bottom edge (no empty gap)
    ctx.textAlign = 'center';

    // BEST SCORE
    ctx.textBaseline = 'top';
    ctx.fillStyle = P.gold;
    ctx.font = 'bold 11px "Noto Sans JP", sans-serif';
    ctx.fillText('BEST SCORE', x1 + w1 / 2, labelY);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = P.textDim;
    ctx.font = 'bold 22px "Oswald", "Arial Narrow", sans-serif';
    ctx.fillText(String(st.highScore), x1 + w1 / 2, valY);

    // SCORE (primary)
    ctx.textBaseline = 'top';
    ctx.fillStyle = P.gold;
    ctx.font = 'bold 11px "Noto Sans JP", sans-serif';
    ctx.fillText('SCORE', x2 + w2 / 2, labelY);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = P.text;
    const scoreStr = String(st.score);
    ctx.font = `bold ${scoreStr.length > 6 ? 28 : 34}px "Oswald", "Arial Narrow", sans-serif`;
    ctx.shadowColor = P.goldBrt;
    ctx.shadowBlur = 7 + 4 * (0.5 + 0.5 * Math.sin(Date.now() * 0.005)); // gentle pulse
    ctx.fillText(scoreStr, x2 + w2 / 2, valY);
    ctx.shadowBlur = 0;

    // 最大進化
    ctx.textBaseline = 'top';
    ctx.fillStyle = P.gold;
    ctx.font = 'bold 11px "Noto Sans JP", sans-serif';
    ctx.fillText('最大進化', x3 + w3 / 2, labelY);
    ctx.textBaseline = 'middle';
    const ev = evoName(st.maxLevel);
    const evShort = ev.length > 7 ? ev.slice(0, 7) : ev;
    let efs = 17;
    ctx.font = `bold ${efs}px "Noto Sans JP", sans-serif`;
    while (ctx.measureText(evShort).width > w3 - 8 && efs > 10) {
      efs -= 1; ctx.font = `bold ${efs}px "Noto Sans JP", sans-serif`;
    }
    drawNameText(ctx, evShort, x3 + w3 / 2, valY, st.maxLevel, efs);
  }, [drawMonster, drawNameText]);

  // ── Live HUD drawn ON TOP of the decorative frame skin ──────
  //    (the frame.png provides the panels/labels-less plates; we paint the
  //    live values into them, plus the NEXT monster and the aim piece.)
  const drawLiveHUD = useCallback((ctx: CanvasRenderingContext2D, st: GS) => {
    // NEXT monster (top-left plate)
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = P.gold;
    ctx.font = 'bold 10px "Noto Sans JP", sans-serif';
    ctx.fillText('NEXT', FA.nextX, FA.nextLabelY);
    const nm = MONSTERS[st.nextLevel];
    const nmr = Math.min(nm.radius, 24) * 0.8;
    const scn = nmr / nm.radius;
    ctx.translate(FA.nextX, FA.nextY);
    ctx.scale(scn, scn);
    drawMonster(ctx, 0, 0, st.nextLevel, 0.95);
    ctx.restore();

    // Bottom plates: BEST | SCORE | 最大進化
    ctx.save();
    ctx.textAlign = 'center';
    const label = (x: number, text: string) => {
      ctx.textBaseline = 'middle';
      ctx.fillStyle = P.gold;
      ctx.font = 'bold 13px "Noto Sans JP", sans-serif';
      ctx.fillText(text, x, FA.labelY);
    };
    label(FA.bestX, 'BEST');
    label(FA.scoreX, 'SCORE');
    label(FA.evoX, '最大進化');

    ctx.textBaseline = 'middle';
    ctx.fillStyle = P.textDim;
    ctx.font = 'bold 22px "Oswald", "Arial Narrow", sans-serif';
    ctx.fillText(String(st.highScore), FA.bestX, FA.valueY);

    ctx.fillStyle = P.text;
    const ss = String(st.score);
    ctx.font = `bold ${ss.length > 6 ? 24 : 30}px "Oswald", "Arial Narrow", sans-serif`;
    ctx.shadowColor = P.goldBrt;
    ctx.shadowBlur = 7 + 4 * (0.5 + 0.5 * Math.sin(Date.now() * 0.005));
    ctx.fillText(ss, FA.scoreX, FA.valueY);
    ctx.shadowBlur = 0;

    const ev = evoName(st.maxLevel);
    const evShort = ev.length > 7 ? ev.slice(0, 7) : ev;
    let efs = 16;
    ctx.font = `bold ${efs}px "Noto Sans JP", sans-serif`;
    while (ctx.measureText(evShort).width > 0.21 * W && efs > 10) {
      efs -= 1; ctx.font = `bold ${efs}px "Noto Sans JP", sans-serif`;
    }
    drawNameText(ctx, evShort, FA.evoX, FA.valueY, st.maxLevel, efs);
    ctx.restore();

    // Aim piece drawn LAST so it appears above the frame, NEXT panel and all HUD
    if (st.phase === 'playing') {
      drawMonster(ctx, st.dropX, DROP_Y, st.currentLevel);
      if (st.canDrop) {
        const r = MONSTERS[st.currentLevel].radius;
        const now = Date.now();
        ctx.save();
        ctx.strokeStyle = 'rgba(180,190,255,0.32)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([5, 7]);
        ctx.lineDashOffset = -(now * 0.02) % 12;
        ctx.beginPath();
        ctx.moveTo(st.dropX, DROP_Y + r + 2);
        ctx.lineTo(st.dropX, FLOOR_Y);
        ctx.stroke();
        ctx.setLineDash([]);
        const pulse = 0.5 + 0.5 * Math.sin(now * 0.006);
        ctx.strokeStyle = `rgba(200,210,255,${0.22 + 0.30 * pulse})`;
        ctx.beginPath();
        ctx.ellipse(st.dropX, FLOOR_Y - 4, r * 0.55, 5, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
  }, [drawMonster, drawNameText]);

  // Draw one option icon at a frame circle.
  // Pause/play are drawn as geometric shapes (cross-platform reliable).
  // Emoji icons get explicit globalAlpha=1 + white fillStyle so they render
  // correctly on PC even when a previous draw left globalAlpha or fillStyle dirty.
  const drawOptionIcon = useCallback((
    ctx: CanvasRenderingContext2D, cx: number, cy: number,
    icon: string,   // '🥚' | '🔊' | '🔇' | 'PAUSE' | 'PLAY'
    disc = false,
  ) => {
    const x = zx(cx), y = zy(cy);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (disc) {
      ctx.fillStyle = 'rgba(8,8,28,0.62)';
      ctx.beginPath(); ctx.arc(x, y, OPT_R + 4, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(200,160,48,0.75)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, OPT_R + 4, 0, Math.PI * 2); ctx.stroke();
    }
    if (icon === 'PAUSE') {
      // Two white vertical bars
      const bw = 4, bh = 13, gap = 5;
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
      ctx.fillRect(x - gap / 2 - bw, y - bh / 2, bw, bh);
      ctx.fillRect(x + gap / 2,       y - bh / 2, bw, bh);
    } else if (icon === 'PLAY') {
      // White right-pointing triangle
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3;
      ctx.beginPath();
      ctx.moveTo(x - 6, y - 8);
      ctx.lineTo(x + 9, y);
      ctx.lineTo(x - 6, y + 8);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.font = `${OPT_R + 3}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 3;
      ctx.fillText(icon, x, y + 1);
    }
    ctx.restore();
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

  // ── Merge burst: a bright flash + light orbs + sparkle stars + rings ──
  const spawnBurst = useCallback((x: number, y: number, color: string, big: boolean) => {
    const now = Date.now();

    // 1. central flash pop (large, bright, stationary, very short-lived)
    particlesRef.current.push({
      x, y, vx: 0, vy: 0,
      r: big ? 56 : 40, start: now, life: big ? 280 : 220, color,
    });

    // 2. flying light orbs (more, bigger, faster than before)
    const n = big ? 40 : 26;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const spd = (big ? 3.6 : 2.6) + Math.random() * (big ? 5.4 : 3.8);
      particlesRef.current.push({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        r: (big ? 6.5 : 4.5) + Math.random() * (big ? 8 : 5.5),
        start: now,
        life: big ? 880 : 700,
        color,
      });
    }

    // 3. bright twinkling sparkle stars shooting out (high visibility)
    const ns = big ? 12 : 7;
    for (let i = 0; i < ns; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = (big ? 4.5 : 3.4) + Math.random() * (big ? 5 : 3.5);
      particlesRef.current.push({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        r: (big ? 9 : 7) + Math.random() * 5,
        start: now,
        life: big ? 760 : 620,
        color: '#fff6da',
        star: true,
      });
    }

    // 4. double expanding flash ring (colour + bright white inner)
    ringsRef.current.push({ x, y, start: now, life: big ? 520 : 380, maxR: big ? 140 : 92, color });
    ringsRef.current.push({ x, y, start: now, life: big ? 360 : 260, maxR: big ? 90 : 58, color: '#ffffff' });
  }, []);

  // ── Draw + advance merge bursts (orbs & rings) ──────────────
  const drawParticles = useCallback((ctx: CanvasRenderingContext2D, step: boolean) => {
    const now = Date.now();

    // expanding flash rings (bright, glowing)
    const rings = ringsRef.current;
    for (let i = rings.length - 1; i >= 0; i--) {
      const rg = rings[i];
      const t = (now - rg.start) / rg.life;
      if (t >= 1) { rings.splice(i, 1); continue; }
      const r = rg.maxR * (0.15 + 0.85 * t);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.strokeStyle = rg.color;
      ctx.lineWidth = 5 * (1 - t) + 1;
      ctx.shadowColor = rg.color;
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.arc(rg.x, rg.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // light orbs + sparkle stars
    const ps = particlesRef.current;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      const t = (now - p.start) / p.life;
      if (t >= 1) { ps.splice(i, 1); continue; }
      if (step) {
        p.x += p.vx; p.y += p.vy;
        p.vy += 0.06; p.vx *= 0.95; p.vy *= 0.95;
      }
      const a = 1 - t;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      if (p.star) {
        // twinkling 4-point star
        const tw = 0.55 + 0.45 * Math.sin(now * 0.03 + p.x);
        const R = p.r * (1 - 0.45 * t) * tw;
        ctx.globalAlpha = a;
        ctx.shadowColor = hexA(p.color, 0.95);
        ctx.shadowBlur = R * 2.2;
        ctx.fillStyle = '#fffdf0';
        star4(ctx, p.x, p.y, R);
        ctx.fill();
      } else {
        const rr = p.r * (1 - 0.5 * t);
        ctx.shadowColor = hexA(p.color, a);
        ctx.shadowBlur = rr * 1.6;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
        g.addColorStop(0,   hexA('#ffffff', a));
        g.addColorStop(0.4, hexA(p.color, a * 0.95));
        g.addColorStop(1,   hexA(p.color, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }, [star4]);

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

      ctx.fillStyle = e.maxLevel >= MAX_LEVEL ? '#d0b0ff' : P.textDim;
      ctx.font = '9px "Noto Sans JP", sans-serif';
      const ev = rankEvoLabel(e);
      const shown = e.maxLevel >= MAX_LEVEL ? ev : (ev.length > 7 ? ev.slice(0, 7) : ev);
      ctx.fillText(shown, x + w - 6, cy);
    });
  }, []);

  // ── Start screen ────────────────────────────────────────────
  const drawStart = useCallback((ctx: CanvasRenderingContext2D) => {
    // No dark overlay — the background image shows through; only the text
    // and (semi-transparent) UI are drawn.

    // Acrostic title (big leading chars read downward = スイガゲーム)
    {
      const lines: [string, string][] = [
        ['ス', 'ごい'],
        ['イ', 'きおいで'],
        ['ガ', 'ったいさせたら最後に知らない人がでてきて唖然とした'],
        ['ゲーム', ''],
      ];
      // Pop, bright pastel palette (blue / green / red·pink / warm), cycled
      // per line so the title reads cheerful instead of dark & mystic.
      const pops = [
        { fill: '#8fd3ff', deep: '#2f9be8', glow: '#7ec8ff' }, // blue
        { fill: '#a6f0a0', deep: '#3fc24f', glow: '#8fe890' }, // green
        { fill: '#ffb3c2', deep: '#ff5d7a', glow: '#ff8fa3' }, // red / pink
        { fill: '#ffe79a', deep: '#ffb43a', glow: '#ffd166' }, // warm yellow
      ];
      const popFont = '900 52px "Hiragino Maru Gothic ProN", "Rounded Mplus 1c", "Noto Sans JP", system-ui, sans-serif';
      const lh = 58, baseY = 102;
      const now = Date.now();
      // Find widest line → shared x0 so big acrostic chars align in a vertical column
      ctx.font = popFont;
      let _maxW = 0;
      lines.forEach(([red, white]) => {
        let _lw = ctx.measureText(red).width;
        if (white) {
          ctx.font = 'bold 13px "Noto Sans JP", sans-serif';
          _lw += 4 + ctx.measureText(white).width;
          ctx.font = popFont;
        }
        if (_lw > _maxW) _maxW = _lw;
      });
      const x0 = Math.max(8, CX - _maxW / 2);
      ctx.save();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      lines.forEach(([red, white], i) => {
        const by = baseY + i * lh;
        const c = pops[i % pops.length];
        let x = x0;
        ctx.font = popFont;
        ctx.lineJoin = 'round';
        const bob = Math.sin(now * 0.0024 + i * 0.8) * 3; // playful bounce
        const yy = by + bob;
        // 1. outlines for definition against the bright background:
        //    a coloured (deep) halo first, then a crisp white sticker edge.
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 7; ctx.shadowOffsetY = 3;
        ctx.lineWidth = 12; ctx.strokeStyle = c.deep;   // coloured halo
        ctx.strokeText(red, x, yy);
        ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        ctx.lineWidth = 6; ctx.strokeStyle = '#ffffff'; // white sticker edge
        ctx.strokeText(red, x, yy);
        ctx.restore();
        // 2. saturated pastel fill (only a small top highlight so the colour
        //    stays vivid instead of blowing out to white) + gentle glow.
        ctx.save();
        ctx.shadowColor = c.glow;
        ctx.shadowBlur = 9 + 4 * (0.5 + 0.5 * Math.sin(now * 0.003 + i));
        const g = ctx.createLinearGradient(0, yy - 46, 0, yy + 7);
        g.addColorStop(0,    '#ffffff');
        g.addColorStop(0.20, c.fill);
        g.addColorStop(1,    c.deep);
        ctx.fillStyle = g;
        ctx.fillText(red, x, yy);
        ctx.restore();
        x += ctx.measureText(red).width + 4;
        if (white) {
          // bigger + higher-contrast white sub-text (black outline + shadow)
          ctx.save();
          ctx.font = 'bold 13px "Noto Sans JP", sans-serif';
          ctx.lineJoin = 'round';
          ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1;
          ctx.lineWidth = 4;
          ctx.strokeStyle = 'rgba(0,0,0,0.85)';
          ctx.strokeText(white, x, by - 9);
          ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
          ctx.fillStyle = '#ffffff';
          ctx.fillText(white, x, by - 9);
          ctx.restore();
        }
      });
      ctx.restore();
    }

    // ── Decorative gold rule (rich = ornate, used in the title gap) ──
    const drawRule = (cy: number, rich: boolean) => {
      const x1 = 36, x2 = W - 36, mid = CX;
      const gap = rich ? 16 : 11;
      ctx.save();
      const g = ctx.createLinearGradient(x1, 0, x2, 0);
      g.addColorStop(0,   'rgba(200,160,48,0)');
      g.addColorStop(0.5, P.gold);
      g.addColorStop(1,   'rgba(200,160,48,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = rich ? 1.6 : 1.2;
      ctx.beginPath();
      ctx.moveTo(x1, cy); ctx.lineTo(mid - gap, cy);
      ctx.moveTo(mid + gap, cy); ctx.lineTo(x2, cy);
      ctx.stroke();
      // centre diamond ornament
      const ds = rich ? 7 : 5;
      ctx.shadowColor = P.goldBrt; ctx.shadowBlur = rich ? 10 : 5;
      ctx.fillStyle = rich ? P.goldBrt : P.gold;
      ctx.beginPath();
      ctx.moveTo(mid, cy - ds); ctx.lineTo(mid + ds, cy);
      ctx.lineTo(mid, cy + ds); ctx.lineTo(mid - ds, cy);
      ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      if (rich) {
        // ornate outline + flanking dots
        ctx.strokeStyle = 'rgba(255,224,80,0.7)'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(mid, cy - ds - 4); ctx.lineTo(mid + ds + 4, cy);
        ctx.lineTo(mid, cy + ds + 4); ctx.lineTo(mid - ds - 4, cy);
        ctx.closePath(); ctx.stroke();
        ctx.fillStyle = P.gold;
        [mid - gap - 16, mid + gap + 16].forEach((dx) => {
          ctx.beginPath(); ctx.arc(dx, cy, 1.8, 0, Math.PI * 2); ctx.fill();
        });
      }
      ctx.restore();
    };
    drawRule(TITLE_DIV_Y, true);  // rich rule between title and the menu
    drawRule(NAME_DIV_Y, false);  // rule below the player-name input

    // Pointer-hover test (canvas-space) for mouse-over button lighting
    const pt = pointerRef.current;
    const isHover = (b: { x: number; y: number; w: number; h: number }) =>
      pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h;

    // Menu button helper
    const menuBtn = (
      b: { x: number; y: number; w: number; h: number },
      label: string,
      primary: boolean,
    ) => {
      const hover = isHover(b);
      const g = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
      if (primary) {
        // gold, lightly translucent so the bg shows faintly (brighter on hover)
        const edge = hover ? 0.92 : 0.82;
        const mid  = hover ? 'rgba(232,188,72,0.94)' : 'rgba(200,160,48,0.82)';
        g.addColorStop(0, `rgba(58,42,0,${edge})`); g.addColorStop(0.5, mid); g.addColorStop(1, `rgba(58,42,0,${edge})`);
      } else {
        // dark, more translucent (lifts on hover)
        const edge = hover ? 0.72 : 0.5;
        const mid  = hover ? 'rgba(44,44,98,0.78)' : 'rgba(22,22,60,0.5)';
        g.addColorStop(0, `rgba(10,10,36,${edge})`); g.addColorStop(0.5, mid); g.addColorStop(1, `rgba(10,10,36,${edge})`);
      }
      ctx.fillStyle = g;
      rrect(ctx, b.x, b.y, b.w, b.h, 10); ctx.fill();
      // glossy top sheen
      ctx.save();
      rrect(ctx, b.x, b.y, b.w, b.h, 10); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(b.x, b.y + 2, b.w, b.h * 0.42);
      ctx.restore();
      ctx.strokeStyle = (primary || hover) ? P.goldBrt : P.gold;
      ctx.lineWidth = primary ? 2 : 1.5;
      rrect(ctx, b.x, b.y, b.w, b.h, 10); ctx.stroke();
      if (primary || hover) { ctx.shadowColor = P.goldBrt; ctx.shadowBlur = hover ? 18 : 14; }
      ctx.fillStyle = primary ? '#fffadc' : (hover ? '#fff4d6' : P.text);
      ctx.font = `bold ${primary ? 20 : 17}px "Noto Sans JP", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2);
      ctx.shadowBlur = 0;
    };

    // Player name label (the editable input itself is an HTML overlay)
    ctx.save();
    ctx.font = 'bold 11px "Noto Sans JP", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    {
      // dark backing pill so the label stays legible over busy/bright artwork
      const label = 'プレイヤー名（ランキング表示用）';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      rrect(ctx, CX - tw / 2 - 10, NAME_LABEL_Y - 14, tw + 20, 19, 8);
      ctx.fill();
      ctx.fillStyle = P.gold;
      ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
      ctx.fillText(label, CX, NAME_LABEL_Y);
    }
    ctx.restore();

    // Player-name input BOX + text drawn on canvas (the editable field is a
    // fully transparent HTML overlay on top). Drawing the visible box here means
    // it always lines up with the menu buttons, immune to mobile form-control
    // scaling quirks (e.g. it looked wider/offset in portrait before).
    {
      const bx = MENU_START_BTN.x, bw = MENU_START_BTN.w;
      const by = NAME_INPUT_TOP, bh = NAME_INPUT_H;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      rrect(ctx, bx, by, bw, bh, 6); ctx.fill();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
      rrect(ctx, bx, by, bw, bh, 6); ctx.stroke();
      const val = playerNameRef.current.trim();
      ctx.font = 'bold 15px "Noto Sans JP", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = val ? '#ffffff' : 'rgba(255,255,255,0.45)';
      ctx.fillText(val || 'ぼうけんしゃ', bx + bw / 2, by + bh / 2 + 1);
      ctx.restore();
    }

    menuBtn(MENU_START_BTN, '⚔  ゲームスタート  ⚔', true);

    // 対戦モード — distinct purple gradient so it stands out
    {
      const b = MENU_BATTLE_BTN;
      const hover = isHover(b);
      const g = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
      const edge = hover ? 0.92 : 0.86;
      const mid  = hover ? 'rgba(150,52,238,0.94)' : 'rgba(122,31,208,0.86)';
      g.addColorStop(0, `rgba(26,0,48,${edge})`); g.addColorStop(0.5, mid); g.addColorStop(1, `rgba(26,0,48,${edge})`);
      ctx.fillStyle = g;
      rrect(ctx, b.x, b.y, b.w, b.h, 10); ctx.fill();
      ctx.save();
      rrect(ctx, b.x, b.y, b.w, b.h, 10); ctx.clip();
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(b.x, b.y + 2, b.w, b.h * 0.42);
      ctx.restore();
      ctx.strokeStyle = hover ? '#e0a0ff' : '#c060ff'; ctx.lineWidth = 2;
      rrect(ctx, b.x, b.y, b.w, b.h, 10); ctx.stroke();
      ctx.shadowColor = '#a040ff'; ctx.shadowBlur = hover ? 20 : 14;
      ctx.fillStyle = hover ? '#fbeaff' : '#f3d2ff';
      ctx.font = 'bold 19px "Noto Sans JP", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🆚  対戦モード（最大4人）', b.x + b.w / 2, b.y + b.h / 2);
      ctx.shadowBlur = 0;
    }

    menuBtn(MENU_RANK_BTN,    '🏆  ランキング', false);
    menuBtn(MENU_REPORT_BTN, '📢  報告・要望', false);
    menuBtn(MENU_SET_BTN,    '⚙  セッティング', false);
    menuBtn(MENU_HOW_BTN,    '📖  遊び方', false);

    // Sound toggle (TOP screen) — canvas-drawn with a backing disc; tapped via
    // the canvas hit-test (no HTML button, so no mobile scaling drift).
    drawOptionIcon(ctx, OPT_SND_START.x, OPT_SND_START.y,
      (bgmOnRef.current && seOnRef.current) ? '🔊' : '🔇', true);
  }, [drawOptionIcon]);

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

    // Score — count-up animation for the first 1.4 s after game over
    const goAge = goStartRef.current ? Date.now() - goStartRef.current : 99999;
    const displayScore = goAge < 1400
      ? Math.floor(st.score * Math.min(1, goAge / 1400))
      : st.score;
    ctx.shadowColor = P.goldBrt; ctx.shadowBlur = 10;
    ctx.fillStyle = P.goldBrt;
    ctx.font = 'bold 38px "Oswald", "Arial Narrow", sans-serif';
    ctx.fillText(String(displayScore), CX, by + 70);
    ctx.shadowBlur = 0;

    const isNew = st.score > 0 && lastRankIdxRef.current === 0;
    ctx.fillStyle = isNew ? '#ff9050' : P.gold;
    ctx.font = isNew ? 'bold 11px "Noto Sans JP"' : '10px "Noto Sans JP"';
    ctx.fillText(isNew ? '🎉  NEW RECORD!  🎉' : `ベスト: ${st.highScore}`, CX, by + 118);

    // Max evolution reached — reveal 知らない人＋N if reached, else masked name
    ctx.fillStyle = st.maxLevel >= MAX_LEVEL ? '#d0b0ff' : P.textDim;
    ctx.font = '10px "Noto Sans JP", sans-serif';
    const evoSelf = st.maxLevel >= MAX_LEVEL ? (st.unknownCount > 0 ? `知らない人＋${st.unknownCount}` : '知らない人') : evoName(st.maxLevel);
    ctx.fillText('最大進化: ' + evoSelf, CX, by + 138);

    // Divider
    ctx.strokeStyle = P.gold; ctx.lineWidth = 1; ctx.globalAlpha = 0.3;
    ctx.beginPath(); ctx.moveTo(bx + 20, by + 162); ctx.lineTo(bx + bw - 20, by + 162); ctx.stroke();
    ctx.globalAlpha = 1;

    // Ranking
    ctx.fillStyle = P.gold;
    ctx.font = 'bold 11px "Noto Sans JP", sans-serif';
    ctx.fillText('🏆  ランキング  TOP10', CX, by + 172);
    drawRanking(ctx, bx + 14, by + 192, bw - 28, 22, 10, lastRankIdxRef.current);

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

    // Retry (primary) + TOP / view-board / screenshot (secondary row)
    btn(GO_BTN, '#1a0030', '#6030c0', '#a060ff', '#f0e0ff', '⚔  もう一度挑戦  ⚔', 15);
    btn(GO_TOP_BTN, '#2a2200', '#b89020', '#ffd24a', '#fff6d0', '🏠 TOPへ', 12);
    btn(GO_VIEW_BTN, '#0a2a10', '#2a9c46', '#6cff9a', '#e6ffe9', '👁 盤面', 12);
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

  // ── Pause overlay ───────────────────────────────────────────────
  const drawPauseOverlay = useCallback((ctx: CanvasRenderingContext2D) => {
    ctx.save();
    ctx.fillStyle = 'rgba(4,4,20,0.72)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = P.gold;
    ctx.shadowBlur = 20;
    ctx.fillStyle = P.goldBrt;
    ctx.font = 'bold 38px "Noto Serif JP", serif';
    ctx.fillText('⏸  P A U S E', CX, H / 2 - 18);
    ctx.shadowBlur = 0;
    ctx.fillStyle = P.textDim;
    ctx.font = '13px "Noto Sans JP", sans-serif';
    ctx.fillText('ポーズボタンを押して再開', CX, H / 2 + 24);
    ctx.font = '11px "Noto Sans JP", sans-serif';
    ctx.fillStyle = 'rgba(160,130,200,0.75)';
    ctx.fillText('🥚 ボタンで進化ルートを確認できます', CX, H / 2 + 50);
    ctx.restore();
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
      gs.current.mergeCounts[level] = (gs.current.mergeCounts[level] ?? 0) + 1;

      // Merge SE — richer the bigger the combo
      if (level === MAX_LEVEL) {
        playSe('/se/shiranaihito.wav', 0.8, seShiranaihitoRef.current);
        try { navigator.vibrate?.(50); } catch { /* */ }
      } else {
        playComboMerge(combo);
        try { navigator.vibrate?.(combo >= 3 ? [30, 20, 30] : 25); } catch { /* */ }
      }

      // Light-orb burst at the merge point (colour = the new evolution)
      const burstColor = level === MAX_LEVEL ? '#c8a0ff' : MONSTERS[level + 1].glowColor;
      spawnBurst(mx, my, burstColor, level >= 6 || level === MAX_LEVEL);

      // Floating popups (juicy feedback)
      popupsRef.current.push({ x: mx, y: my, text: `+${gain}`, start: now, big: level === MAX_LEVEL });
      if (combo >= 2) {
        popupsRef.current.push({ x: mx, y: my - 30, text: `${combo} COMBO!`, start: now, big: true });
      }

      if (level === MAX_LEVEL) {
        // special merge: both vanish, no new body
        gs.current.unknownCount++;
      } else {
        const nextLevel = level + 1;
        const newBody = spawnMonster(Matter, mx, Math.max(my, CEILING_Y + MONSTERS[nextLevel].radius), nextLevel);
        Matter.Body.setVelocity(newBody, {
          x: (bodyA.velocity.x + bodyB.velocity.x) * 0.3,
          y: -2.5,
        });
        Matter.Body.setAngularVelocity(newBody, (Math.random() - 0.5) * 0.04);
        // birth animation marker
        const bd = bodyDataRef.current.get(newBody.id);
        if (bd) bd.mergedAt = Date.now();
        // 知らない人 が初めて誕生した瞬間の演出
        if (nextLevel === MAX_LEVEL) {
          triggerSecretFx();
          window.setTimeout(() => playSe('/se/shiranaihito.wav', 0.8, seShiranaihitoRef.current), 2500);
          try { navigator.vibrate?.([80, 30, 80]); } catch { /* */ }
        }
      }

      const s = gs.current;
      if (s.score > s.highScore) {
        s.highScore = s.score;
        try { localStorage.setItem('sporinkaHighScore', String(s.score)); } catch { /* */ }
      }
    }, 80);
  }, [spawnMonster, triggerSecretFx, playSe, playComboMerge, spawnBurst]);

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

    // falling SE: track this body and play until it first lands
    fallingIdRef.current = body.id;
    playFall();

    st.currentLevel = st.nextLevel;
    st.nextLevel    = getRandomStartLevel();
    st.canDrop      = false;
    coolRef.current = Date.now() + DROP_COOLDOWN;
    setTimeout(() => { gs.current.canDrop = true; }, DROP_COOLDOWN);
  }, [spawnMonster, playFall]);

  // ── Pause toggle ────────────────────────────────────────────
  const togglePause = useCallback(() => {
    const newVal = !isPausedRef.current;
    isPausedRef.current = newVal;
    setIsPaused(newVal);
    if (newVal) stopFall(); // don't let the falling SE play through a pause
    syncBgm(); // pause the active BGM, or resume the phase-appropriate one
  }, [syncBgm, stopFall]);

  // ── Open the evolution-route popup (same content as the TOP "遊び方")
  //    Auto-pause while it's open during play so the game can't end. ──
  const openEvolution = useCallback(() => {
    if (gs.current.phase === 'playing' && !isPausedRef.current) {
      togglePause();
      pausedForModalRef.current = true;
    }
    modalRef.current = 'howto';
    setModal('howto');
  }, [togglePause]);

  // ── Ask before returning to TOP mid-game (score is not recorded). Pause
  //    while the dialog is up so the game can't end behind it. ──
  const confirmGoToTop = useCallback(() => {
    if (gs.current.phase === 'playing' && !isPausedRef.current) {
      togglePause();
      pausedForModalRef.current = true;
    }
    modalRef.current = 'confirmTop';
    setModal('confirmTop');
  }, [togglePause]);

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
    st.unknownCount   = 0;
    st.phase          = 'playing';
    coolRef.current   = 0;
    shakeRef.current  = 0;
    goStartRef.current = 0;
    secretFxRef.current = null;
    popupsRef.current = [];
    particlesRef.current = [];
    ringsRef.current = [];
    comboRef.current = { count: 0, lastTime: 0 };
    stopFall();
    snapshotRef.current = null;
    viewingRef.current = false;
    isPausedRef.current = false;
    setIsPaused(false);

    // Physics world
    const engine = Matter.Engine.create({ gravity: { x: 0, y: 1.8 } });
    engineRef.current = engine;

    const ground = Matter.Bodies.rectangle(CX, FLOOR_Y + 40, W + 200, 80,  { isStatic: true, label: 'ground', friction: 0.6 });
    const leftW  = Matter.Bodies.rectangle(GL - 50, H / 2, 100, H * 2, { isStatic: true, label: 'wall', friction: 0.4 });
    const rightW = Matter.Bodies.rectangle(GR + 50, H / 2, 100, H * 2, { isStatic: true, label: 'wall', friction: 0.4 });
    Matter.Composite.add(engine.world, [ground, leftW, rightW]);

    // "ぷにっ" — squash a body on a hard contact (landing / impact)
    const triggerSquash = (b: import('matter-js').Body) => {
      const d = bodyDataRef.current.get(b.id);
      if (!d || d.isMerging) return;
      const speed = Math.hypot(b.velocity.x, b.velocity.y);
      if (speed < 4) return; // ignore gentle resting contacts
      const now = Date.now();
      if (d.squashT && now - d.squashT < 90) return; // don't re-trigger every frame
      d.squashT = now;
      d.squashAmp = Math.min(0.24, 0.02 + speed * 0.011);
    };

    Matter.Events.on(engine, 'collisionStart', (event: import('matter-js').IEventCollision<import('matter-js').Engine>) => {
      for (const pair of event.pairs) {
        // compound bodies report child parts → resolve to the parent
        const a = pair.bodyA.parent ?? pair.bodyA;
        const b = pair.bodyB.parent ?? pair.bodyB;
        // bounce squash on any hard contact (incl. landing on floor/wall)
        if (!a.isStatic) triggerSquash(a);
        if (!b.isStatic) triggerSquash(b);
        // falling SE: cut it the instant the dropped block first lands
        if (fallingIdRef.current >= 0 && (a.id === fallingIdRef.current || b.id === fallingIdRef.current)) {
          stopFall();
        }
        // merge only when two dynamic monster bodies meet
        if (pair.bodyA.isStatic || pair.bodyB.isStatic) continue;
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
    bgmRef.current?.pause();                         // stop the TOP BGM
    if (bgmPlayRef.current) bgmPlayRef.current.currentTime = 0; // restart play BGM
    syncBgm();                                       // start the solo play BGM

    let last = 0;
    const loop = (ts: number) => {
      const dt = Math.min(ts - last, 33);
      last = ts;
      const s = gs.current;

      if (!isPausedRef.current) {
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
            shakeRef.current = 9;
            goStartRef.current = Date.now();
            stopFall();
            bgmRef.current?.pause();
            bgmPlayRef.current?.pause();             // stop the solo play BGM
            const go = bgmGameoverRef.current;
            if (go && bgmOnRef.current) { go.currentTime = 0; go.play().catch(() => {}); }
            if (s.score > s.highScore) {
              s.highScore = s.score;
              try { localStorage.setItem('sporinkaHighScore', String(s.score)); } catch { /* */ }
            }
            const name = (playerNameRef.current.trim() || 'ぼうけんしゃ').slice(0, 10);
            const entry = { name, score: s.score, maxLevel: s.maxLevel, unknown: s.unknownCount, mergeCounts: [...s.mergeCounts], player_id: playerIdRef.current || undefined };
            lastRankIdxRef.current = -1;
            viewingRef.current = false;
            setUiPhase('gameover');
            submitGlobalRanking(entry).then(({ list, index }) => {
              rankingRef.current = list;
              lastRankIdxRef.current = index;
              setRankingTick((t) => t + 1);
            });
          }
        }
      }

      // Render
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      if (shakeRef.current > 0) {
        ctx.translate(
          (Math.random() - 0.5) * shakeRef.current,
          (Math.random() - 0.5) * shakeRef.current,
        );
        shakeRef.current = Math.max(0, shakeRef.current - 0.6);
      }
      const useFrame  = frameReadyRef.current  && frameImgRef.current;
      const useFrame2 = frame2ReadyRef.current && frame2ImgRef.current;
      drawBG(ctx);                 // dark veil/grid inside play field
      if (!useFrame && !useFrame2) { drawWalls(ctx); drawCeiling(ctx); }

      // Pulse factor for the danger outline (visibility)
      const pulse = 0.5 + 0.5 * Math.sin(Date.now() * 0.012);
      const WARN = 22; // px below the line where the warning engages/releases

      const allBodies = Matter.Composite.allBodies(engine.world);
      for (const b of allBodies) {
        if (b.isStatic) continue;
        const d = bodyDataRef.current.get(b.id);
        if (!d) continue;
        const r = MONSTERS[d.monsterId].radius;
        // landing squash: damped, decaying oscillation (flatten → settle)
        let sq = 0;
        if (d.squashT) {
          const el = (Date.now() - d.squashT) / 1000;
          const DUR = 0.34;
          if (el < DUR) sq = (d.squashAmp ?? 0) * Math.cos(el * 26) * (1 - el / DUR);
          else d.squashT = 0;
        }
        drawMonster(ctx, b.position.x, b.position.y, d.monsterId, d.isMerging ? 0.5 : 1, b.angle, sq, d.mergedAt);

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

      // Merge bursts (light orbs) over the monsters, beneath the HUD
      drawParticles(ctx, !isPausedRef.current);

      if (useFrame2) {
        // frame2_alpha: white pixels are pre-processed to alpha=0, so transparent areas
        // show game content through; dark/gold borders appear on top.
        // Outer clip (x=28..531) trims narrow cream-coloured outer margins.
        ctx.save();
        ctx.beginPath();
        ctx.rect(28, 0, 503, H);
        ctx.clip();
        ctx.drawImage(frame2ImgRef.current as HTMLImageElement, 0, 0, W, H);
        ctx.restore();
        drawCeiling(ctx);
        drawLiveHUD(ctx, s);
      } else if (useFrame) {
        ctx.drawImage(
          frameImgRef.current as HTMLImageElement,
          zx(0), zy(0), W * FRAME_ZOOM, H * FRAME_ZOOM,
        );
        drawCeiling(ctx);
        drawLiveHUD(ctx, s);
      } else {
        drawHUD(ctx, s);
      }

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

      if (isPausedRef.current && s.phase === 'playing') drawPauseOverlay(ctx);

      // Option icons painted on top of everything (so they're tappable even
      // over the pause/gameover overlays). Taps are handled in handleClick.
      if (useFrame || useFrame2) {
        const soundOn = bgmOnRef.current && seOnRef.current;
        if (s.phase === 'playing') {
          drawOptionIcon(ctx, OPT_EGG.x, OPT_EGG.y, '🥚', true);
          drawOptionIcon(ctx, OPT_PAUSE.x, OPT_PAUSE.y, isPausedRef.current ? 'PLAY' : 'PAUSE', true);
        }
        drawOptionIcon(ctx, OPT_SND.x, OPT_SND.y, soundOn ? '🔊' : '🔇', true);
      }

      ctx.restore(); // shake transform
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [drawBG, drawWalls, drawCeiling, drawMonster, drawHUD, drawLiveHUD, drawGameOver, drawBoardView, drawPopups, drawParticles, drawSecretFx, drawPauseOverlay, drawOptionIcon, handleMerge, syncBgm, stopFall]);

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

  // ── Start screen render loop (reused on mount and on return to TOP) ──
  const runStartLoop = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const loop = () => {
      // TOP screen: keep the canvas transparent (everything but the text /
      // UI is see-through) so the full-screen background image shows.
      ctx.clearRect(0, 0, W, H);
      drawStart(ctx);
      if (gs.current.phase === 'start') {
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [drawStart]);

  // ── Return to the TOP menu (from the game-over screen) ──────
  const goToTop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    gs.current.phase = 'start';
    viewingRef.current = false;
    setUiPhase('start');
    // stop the game-over jingle + play BGM, resume the TOP BGM
    const go = bgmGameoverRef.current;
    if (go) { go.pause(); go.currentTime = 0; }
    bgmPlayRef.current?.pause();
    if (bgmRef.current) bgmRef.current.currentTime = 0;
    syncBgm();
    runStartLoop();
  }, [runStartLoop, syncBgm]);

  // ── Start screen animation (mount) ─────────────────────────
  useEffect(() => {
    gs.current.phase = 'start';
    runStartLoop();
    return () => cancelAnimationFrame(rafRef.current);
  }, [runStartLoop]);

  // ── Responsive scale ────────────────────────────────────────
  useEffect(() => {
    const update = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      // Fit the board to BOTH the available width and height, and allow
      // it to grow beyond 1×. Reserve room for the 🏠 button above the board
      // (TOP_OFFSET) and a slim bottom margin so the board sits a touch larger
      // ("一回り大きく") while keeping its fixed 2:3 aspect.
      const TOP_OFFSET = 44;
      const availW = (wrap.parentElement?.clientWidth ?? window.innerWidth) - 4;
      const availH = window.innerHeight - 16 - TOP_OFFSET;
      const s = Math.max(0.2, Math.min(availW / W, availH / H, 2.6));
      scaleRef.current = s;
      wrap.style.transform       = `scale(${s})`;
      wrap.style.transformOrigin = 'top center';
      wrap.style.marginTop       = `${TOP_OFFSET}px`;
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
    const MENU_BTNS = [MENU_START_BTN, MENU_BATTLE_BTN, MENU_RANK_BTN, MENU_REPORT_BTN, MENU_SET_BTN, MENU_HOW_BTN];
    const onMove  = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const s = scaleRef.current;
      const x = (e.clientX - rect.left) / s;
      const y = (e.clientY - rect.top)  / s;
      pointerRef.current = { x, y };
      gs.current.dropX = Math.max(GL + 5, Math.min(GR - 5, x));
      // pointer cursor when hovering a TOP-menu button
      if (gs.current.phase === 'start') {
        const over = MENU_BTNS.some((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
        canvas.style.cursor = over ? 'pointer' : 'crosshair';
      }
    };
    const onLeave = () => { pointerRef.current = { x: -1, y: -1 }; };
    const onTouch = (e: TouchEvent) => { e.preventDefault(); gs.current.dropX = Math.max(GL+5, Math.min(GR-5, toX(e.touches[0].clientX))); };
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    canvas.addEventListener('touchmove', onTouch, { passive: false });
    return () => {
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
      canvas.removeEventListener('touchmove', onTouch);
    };
  }, []);

  // ── Unified click handler (includes button hit-testing) ─────
  const handleClick = useCallback(async (clientX: number, clientY: number) => {
    unlockAudio(); // resume Web Audio on every user gesture (autoplay policy)
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const s  = scaleRef.current;
    const cx = (clientX - rect.left) / s;
    const cy = (clientY - rect.top)  / s;
    const st = gs.current;

    const inBtn = (b: { x: number; y: number; w: number; h: number }) =>
      cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
    // Hit-test a frame option circle (canvas coords, zoom-aware).
    const inCircle = (c: { x: number; y: number }) => {
      const dx = cx - zx(c.x), dy = cy - zy(c.y);
      return dx * dx + dy * dy <= (OPT_R + 6) * (OPT_R + 6);
    };
    const toggleSound = () => {
      unlockAudio();
      const v = !(bgmOnRef.current && seOnRef.current);
      setBgmOn(v); setSeOn(v);
    };

    if (st.phase === 'start') {
      // Unlock BGM on first interaction (browser autoplay policy)
      if (bgmRef.current && bgmRef.current.paused && bgmOnRef.current) {
        bgmRef.current.play().catch(() => {});
      }
      if (modalRef.current !== null) return;
      if (inCircle(OPT_SND_START)) { toggleSound(); return; }
      if (inBtn(MENU_START_BTN)) {
        cancelAnimationFrame(rafRef.current);
        await initGame();
      } else if (inBtn(MENU_BATTLE_BTN)) {
        cancelAnimationFrame(rafRef.current);
        onBattle?.();
      } else if (inBtn(MENU_RANK_BTN)) {
        modalRef.current = 'ranking'; setModal('ranking');
      } else if (inBtn(MENU_REPORT_BTN)) {
        setReportName(playerNameRef.current);
        setReportCategory('不具合報告');
        setReportContent('');
        setReportResult('');
        modalRef.current = 'report'; setModal('report');
      } else if (inBtn(MENU_SET_BTN)) {
        modalRef.current = 'settings'; setModal('settings');
      } else if (inBtn(MENU_HOW_BTN)) {
        modalRef.current = 'howto'; setModal('howto');
      }
    } else if (st.phase === 'gameover') {
      if (inCircle(OPT_SND)) { toggleSound(); return; }
      if (viewingRef.current) {
        // gazing at the final board
        if (inBtn(GO_BACK_BTN)) viewingRef.current = false;
        else if (inBtn(GO_VSHOT_BTN)) saveScreenshot();
      } else if (inBtn(GO_BTN)) {
        cancelAnimationFrame(rafRef.current);
        await initGame();
      } else if (inBtn(GO_TOP_BTN)) {
        goToTop();
      } else if (inBtn(GO_VIEW_BTN)) {
        viewingRef.current = true;
      } else if (inBtn(GO_SHOT_BTN)) {
        saveScreenshot();
      }
    } else {
      // playing — option circles first, otherwise drop
      if (inCircle(OPT_EGG)) { openEvolution(); return; }
      if (inCircle(OPT_PAUSE)) { togglePause(); return; }
      if (inCircle(OPT_SND)) { toggleSound(); return; }
      if (isPausedRef.current) return;  // don't drop while paused
      drop();
    }
  }, [initGame, drop, saveScreenshot, unlockAudio, goToTop, onBattle, openEvolution, togglePause]);

  return (
    <div style={{ width: '100%', display: 'flex', justifyContent: 'center', overflowX: 'hidden' }}>
      <div ref={wrapRef} style={{ position: 'relative', width: W, height: H, flexShrink: 0 }}>
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          style={{ display: 'block', width: W, height: H, maxWidth: 'none', cursor: 'crosshair', touchAction: 'none' }}
          onClick={(e) => handleClick(e.clientX, e.clientY)}
          onTouchMove={(e) => {
            e.preventDefault();
            const t = e.touches[0];
            const rect = canvasRef.current?.getBoundingClientRect();
            if (!rect) return;
            gs.current.dropX = Math.max(GL + 5, Math.min(GR - 5,
              (t.clientX - rect.left) / scaleRef.current
            ));
          }}
          onTouchEnd={(e) => {
            e.preventDefault();
            const t = e.changedTouches[0];
            gs.current.dropX = Math.max(GL + 5, Math.min(GR - 5,
              (t.clientX - (canvasRef.current?.getBoundingClientRect().left ?? 0)) / scaleRef.current
            ));
            handleClick(t.clientX, t.clientY);
          }}
        />
        {/* 初回チュートリアル */}
        {showTutorial && (
          <div style={{
            position: 'absolute', inset: 0,
            background: 'rgba(4,2,16,0.93)',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            zIndex: 300, padding: 24, boxSizing: 'border-box',
          }}>
            <div style={{
              background: 'linear-gradient(135deg,rgba(18,8,48,0.98),rgba(28,10,60,0.98))',
              border: '1.5px solid rgba(200,160,48,0.7)',
              borderRadius: 14, padding: '24px 20px', maxWidth: 320, width: '100%',
              boxShadow: '0 0 40px rgba(140,60,255,0.25)',
            }}>
              <div style={{ textAlign: 'center', fontSize: 22, fontWeight: 900, color: '#ffd060', marginBottom: 14, fontFamily: '"Noto Sans JP", sans-serif' }}>
                🎮 あそびかた
              </div>
              <div style={{ color: '#e0d0b0', fontSize: 13, lineHeight: 2, fontFamily: '"Noto Sans JP", sans-serif', marginBottom: 16 }}>
                <div>👆 タップでモンスターを落とす</div>
                <div>🔗 <strong style={{ color: '#ffd060' }}>同じモンスター同士</strong>をくっつけると合体！</div>
                <div>⬆ 合体すると大きなモンスターに進化</div>
                <div>⚠ DANGER LINEを超えたらゲームオーバー</div>
                <div style={{ marginTop: 6, color: '#c090ff', fontSize: 11 }}>
                  🎯 目指せ「知らない人」の召喚！
                </div>
              </div>
              <button
                style={{
                  display: 'block', width: '100%', padding: '12px',
                  background: 'linear-gradient(180deg,#3a18a0,#7030d0)',
                  border: '1.5px solid #9060ff', borderRadius: 8,
                  color: '#f0e0ff', fontSize: 15, fontWeight: 700,
                  cursor: 'pointer', fontFamily: '"Noto Sans JP", sans-serif',
                }}
                onClick={() => {
                  setShowTutorial(false);
                  try { localStorage.setItem('sporinkaFirstPlay', '1'); } catch { /* */ }
                }}
              >
                はじめる！
              </button>
            </div>
          </div>
        )}
        {/* Admin アナウンスバナー */}
        {sysNotif && (
          <div style={{
            position: 'absolute', top: 14, left: '50%', transform: 'translateX(-50%)',
            background: 'linear-gradient(135deg,rgba(18,8,42,0.96),rgba(40,18,80,0.96))',
            border: '1.5px solid rgba(200,140,255,0.55)',
            borderRadius: 10, padding: '10px 18px',
            zIndex: 9900, maxWidth: '92%', width: 320,
            boxShadow: '0 4px 20px rgba(140,80,255,0.35)',
            pointerEvents: 'none', textAlign: 'center',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#c090ff', marginBottom: 4 }}>
              {sysNotif.type === 'maintenance' ? '🔧 メンテナンス' :
               sysNotif.type === 'event'       ? '🎉 イベント' :
               sysNotif.type === 'achievement' ? '🏆 実績' : '📢 お知らせ'}
              {sysNotif.title ? `　${sysNotif.title}` : ''}
            </div>
            <div style={{ fontSize: 12, color: '#e8d8ff', lineHeight: 1.6 }}>{sysNotif.message}</div>
          </div>
        )}

        {/* Overlay buttons */}
        {(() => {
          const btnBase: React.CSSProperties = {
            position: 'absolute',
            top: 12,
            width: 34,
            height: 34,
            background: 'rgba(6,6,28,0.88)',
            border: '1.5px solid #c8a030',
            borderRadius: 8,
            color: '#f0e0b0',
            fontSize: 18,
            cursor: 'pointer',
            zIndex: 5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            lineHeight: '1',
          };
          // NOTE: the 進化順 / サウンド / 一時停止 options are now drawn on the
          // canvas (in the frame's circles) and tapped via the canvas hit-test
          // in handleClick — HTML buttons mis-scaled on mobile and drifted out
          // of their circles. Only the 🏠 text button remains as HTML here.
          return (
            <>
              {/* TOPに戻る（ゲーム中のみ・確認あり）— 盤面の枠の外（上）に配置 */}
              {uiPhase === 'playing' && (
                <button
                  style={{ ...btnBase, top: -42, left: 0, height: 32, width: 'auto', padding: '0 12px', fontSize: 13, fontWeight: 700 }}
                  onClick={confirmGoToTop}
                  title="TOPに戻る"
                >
                  🏠 TOPに戻る
                </button>
              )}
            </>
          );
        })()}
        {/* プレイヤー名入力（TOP画面のみ） */}
        {uiPhase === 'start' && modal === null && (
          <input
            type="text"
            value={playerNameInput}
            maxLength={10}
            placeholder=""
            onChange={(e) => {
              const v = e.target.value;
              setPlayerNameInput(v);
              playerNameRef.current = v;
              try { localStorage.setItem(PLAYER_NAME_KEY, v); } catch { /* */ }
            }}
            style={{
              position: 'absolute',
              top: NAME_INPUT_TOP,
              left: MENU_START_BTN.x,
              width: MENU_START_BTN.w,
              height: NAME_INPUT_H,
              // Transparent overlay: the visible box + text are drawn on the
              // canvas (always aligned with the buttons). This field only
              // captures focus/typing, so any mobile form-control sizing quirk
              // no longer affects the on-screen layout.
              background: 'transparent',
              border: 'none',
              color: 'transparent',
              caretColor: '#ffffff',
              fontSize: 16,           // ≥16px avoids iOS auto-zoom on focus
              fontWeight: 700,
              textAlign: 'center',
              outline: 'none',
              fontFamily: '"Noto Sans JP", sans-serif',
              boxSizing: 'border-box',
              WebkitTextSizeAdjust: '100%',
              zIndex: 5,
            }}
          />
        )}
      </div>
      {/* Modals render OUTSIDE the scaled board wrapper so the dimmed
          backdrop covers the whole viewport and the panel centres on screen
          (mobile-safe; the board's transform: scale no longer clips it). */}
      {modal !== null && (() => {
          const closeModal = () => {
            modalRef.current = null; setModal(null);
            // resume play if we auto-paused to show the in-game popup
            if (pausedForModalRef.current) { pausedForModalRef.current = false; togglePause(); }
          };
          const panelStyle: React.CSSProperties = {
            background: 'rgba(8,8,28,0.98)',
            border: '1.5px solid #c8a030',
            borderRadius: 12,
            width: modal === 'confirmTop' ? 320 : 360,
            maxWidth: '90vw',
            maxHeight: '85vh',
            overflowY: 'auto',
            padding: '18px 22px 22px',
            boxSizing: 'border-box',
            color: '#f0e0b0',
            fontFamily: '"Noto Sans JP", sans-serif',
            boxShadow: '0 14px 48px rgba(0,0,0,0.6)',
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
                position: 'fixed', inset: 0,
                background: 'rgba(4,4,20,0.88)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 16, boxSizing: 'border-box',
                zIndex: 50,
              }}
              onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
            >
              <div style={panelStyle}>
                {modal === 'ranking' && (<>
                  <h2 style={h2Style}>🏆 ランキング TOP30</h2>
                  {rankingRef.current.length === 0 ? (
                    <p style={{ textAlign: 'center', color: '#8a7a50', fontSize: 12 }}>
                      まだ記録がありません
                    </p>
                  ) : (
                    <div>
                      {rankingRef.current.slice(0, 30).map((e, i) => {
                        const isFirst  = i === 0;
                        const isTop3   = i < 3;
                        const isTop10  = i < 10;
                        const rankColor = i === 0 ? '#ffd24a' : i === 1 ? '#cfd4dd' : i === 2 ? '#d8945a' : i < 10 ? '#a090cc' : '#555570';
                        const nameTrunc = e.name.length > (isFirst ? 10 : isTop10 ? 9 : 8) ? e.name.slice(0, isFirst ? 10 : isTop10 ? 9 : 8) + '…' : e.name;
                        if (isFirst) return (
                          <div key={i} style={{
                            background: 'linear-gradient(135deg,#3a2800,#1a1200,#3a2800)',
                            border: '1.5px solid #ffd24a',
                            borderRadius: 8, padding: '10px 12px', marginBottom: 8,
                            boxShadow: '0 0 12px rgba(255,210,74,0.3)',
                          }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontSize: 22, fontWeight: 900, color: '#ffd24a', minWidth: 32, textShadow: '0 0 8px rgba(255,210,74,0.8)' }}>1</span>
                              <span style={{ fontSize: 16, fontWeight: 700, color: '#fff8e0', flex: 1 }}>{nameTrunc}</span>
                              <span style={{ fontSize: 18, fontWeight: 900, color: '#ffd24a', textShadow: '0 0 6px rgba(255,210,74,0.6)' }}>{e.score.toLocaleString()}</span>
                            </div>
                            <div style={{ textAlign: 'right', fontSize: 10, color: e.maxLevel >= MAX_LEVEL ? '#d0b0ff' : '#aa9060', marginTop: 2 }}>{rankEvoLabel(e)}</div>
                          </div>
                        );
                        if (isTop3) return (
                          <div key={i} style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            borderBottom: '1px solid rgba(200,160,48,0.2)',
                            padding: '7px 4px',
                          }}>
                            <span style={{ fontSize: 15, fontWeight: 800, color: rankColor, minWidth: 24 }}>{i + 1}</span>
                            <span style={{ fontSize: 13, fontWeight: 600, color: '#e8d8b0', flex: 1 }}>{nameTrunc}</span>
                            <span style={{ fontSize: 14, fontWeight: 700, color: '#ffe050' }}>{e.score.toLocaleString()}</span>
                            <span style={{ fontSize: 10, color: e.maxLevel >= MAX_LEVEL ? '#d0b0ff' : '#6a6a90', minWidth: 60, textAlign: 'right' }}>{rankEvoLabel(e)}</span>
                          </div>
                        );
                        if (isTop10) return (
                          <div key={i} style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            borderBottom: '1px solid rgba(120,100,48,0.15)',
                            padding: '5px 4px',
                          }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: rankColor, minWidth: 24 }}>{i + 1}</span>
                            <span style={{ fontSize: 12, color: '#c8b888', flex: 1 }}>{nameTrunc}</span>
                            <span style={{ fontSize: 12, fontWeight: 600, color: '#d0b840' }}>{e.score.toLocaleString()}</span>
                            <span style={{ fontSize: 10, color: e.maxLevel >= MAX_LEVEL ? '#c0a0f0' : '#555570', minWidth: 56, textAlign: 'right' }}>{rankEvoLabel(e)}</span>
                          </div>
                        );
                        return (
                          <div key={i} style={{
                            display: 'flex', alignItems: 'center', gap: 4,
                            borderBottom: '1px solid rgba(80,70,40,0.12)',
                            padding: '3px 4px',
                          }}>
                            <span style={{ fontSize: 10, color: '#444460', minWidth: 24 }}>{i + 1}</span>
                            <span style={{ fontSize: 10, color: '#706858', flex: 1 }}>{nameTrunc}</span>
                            <span style={{ fontSize: 10, color: '#806e40' }}>{e.score.toLocaleString()}</span>
                            <span style={{ fontSize: 9, color: e.maxLevel >= MAX_LEVEL ? '#a080d0' : '#404058', minWidth: 52, textAlign: 'right' }}>{rankEvoLabel(e)}</span>
                          </div>
                        );
                      })}
                    </div>
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
                      <button style={seOn ? onStyle : offStyle} onClick={() => { unlockAudio(); setSeOn(true); }}>ON</button>
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

                {modal === 'report' && (() => {
                  const inputStyle: React.CSSProperties = {
                    width: '100%', boxSizing: 'border-box',
                    padding: '7px 10px',
                    background: 'rgba(4,4,20,0.9)',
                    border: '1px solid #6a4a20',
                    borderRadius: 6,
                    color: '#f0e0b0', fontSize: 13,
                    fontFamily: '"Noto Sans JP", sans-serif',
                  };
                  const labelStyle: React.CSSProperties = {
                    display: 'block', fontSize: 11, color: '#c8a030', marginBottom: 4,
                  };
                  const sendReport = async () => {
                    if (!reportContent.trim()) return;
                    setReportSending(true);
                    try {
                      const res = await fetch('/api/report', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          category: reportCategory,
                          content: reportContent,
                          player_name: reportName || null,
                        }),
                      });
                      const json = await res.json();
                      setReportResult(json.ok ? '送信しました！ありがとうございます 🙏' : `エラー: ${json.error ?? 'unknown'}`);
                    } catch (e) {
                      setReportResult(`エラー: ${String(e)}`);
                    }
                    setReportSending(false);
                  };
                  return (<>
                    <h2 style={h2Style}>📢 報告・要望</h2>
                    {reportResult ? (
                      <div style={{ textAlign: 'center', lineHeight: 1.8, marginBottom: 8 }}>
                        <p style={{ color: reportResult.startsWith('エラー') ? '#f87171' : '#86efac', fontSize: 13 }}>
                          {reportResult}
                        </p>
                        <button style={closeBtn} onClick={() => { setReportResult(''); }}>もう一件送る</button>
                        <button style={{ ...closeBtn, marginTop: 8 }} onClick={() => { modalRef.current = null; setModal(null); }}>閉じる</button>
                      </div>
                    ) : (<>
                      <div style={{ marginBottom: 10 }}>
                        <label style={labelStyle}>お名前（任意）</label>
                        <input
                          style={inputStyle}
                          value={reportName}
                          onChange={e => setReportName(e.target.value)}
                          maxLength={64}
                          placeholder="プレイヤー名"
                        />
                      </div>
                      <div style={{ marginBottom: 10 }}>
                        <label style={labelStyle}>カテゴリ</label>
                        <select
                          style={inputStyle}
                          value={reportCategory}
                          onChange={e => setReportCategory(e.target.value)}
                        >
                          <option value="不具合報告">不具合報告</option>
                          <option value="要望">要望</option>
                          <option value="質問">質問</option>
                          <option value="その他">その他</option>
                        </select>
                      </div>
                      <div style={{ marginBottom: 14 }}>
                        <label style={labelStyle}>内容</label>
                        <textarea
                          style={{ ...inputStyle, height: 100, resize: 'none' }}
                          value={reportContent}
                          onChange={e => setReportContent(e.target.value)}
                          maxLength={2000}
                          placeholder="詳しく教えてください…"
                        />
                      </div>
                      <button
                        style={{
                          display: 'block', width: '100%',
                          padding: '9px 0',
                          background: reportContent.trim() ? 'linear-gradient(180deg,#5a2a00,#c87020,#5a2a00)' : 'rgba(30,30,50,0.8)',
                          border: `1.5px solid ${reportContent.trim() ? '#ffe050' : '#3a3a60'}`,
                          borderRadius: 8,
                          color: reportContent.trim() ? '#fffadc' : '#6a6a90',
                          fontSize: 13, cursor: reportContent.trim() ? 'pointer' : 'default',
                          fontFamily: '"Noto Sans JP", sans-serif',
                          fontWeight: 700,
                        }}
                        onClick={() => void sendReport()}
                        disabled={reportSending || !reportContent.trim()}
                      >
                        {reportSending ? '送信中…' : '📤 送信する'}
                      </button>
                      <button style={closeBtn} onClick={() => { modalRef.current = null; setModal(null); }}>閉じる</button>
                    </>)}
                  </>);
                })()}

                {modal === 'confirmTop' && (<>
                  <h2 style={h2Style}>🏠 TOPに戻りますか？</h2>
                  <p style={{ textAlign: 'center', fontSize: 13, lineHeight: 1.8, color: '#f0e0b0', margin: '0 0 4px' }}>
                    TOPに戻ると、現在のスコアは<br />記録されません。本当に戻りますか？
                  </p>
                  <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 18 }}>
                    <button style={{ ...closeBtn, margin: 0 }} onClick={closeModal}>いいえ</button>
                    <button
                      style={{ ...closeBtn, margin: '0', border: '1.5px solid #ffe050', color: '#fffadc', background: 'linear-gradient(180deg,#3a2a00,#7a6018,#3a2a00)' }}
                      onClick={() => {
                        pausedForModalRef.current = false;
                        isPausedRef.current = false; setIsPaused(false);
                        modalRef.current = null; setModal(null);
                        goToTop();
                      }}
                    >TOPに戻る</button>
                  </div>
                </>)}
              </div>
            </div>
          );
        })()}
    </div>
  );
}
