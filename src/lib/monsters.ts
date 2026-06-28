export interface MonsterDef {
  id: number;
  name: string;
  icon: string;
  imageSrc: string;
  // Optional sprite cleanup (applied in buildSprite):
  keepLargest?: boolean;                       // keep only the main body, drop detached bits
  erase?: [number, number, number][];          // erase circles [nx, ny, nr] (normalized to width)
  radius: number;
  color: string;
  highlightColor: string;
  shadowColor: string;
  glowColor: string;
  borderColor: string;
  iconColor: string;
  iconGlow: string;
  score: number;
}

export const MONSTERS: MonsterDef[] = [
  {
    id: 0,
    name: 'ペコペコの卵',
    icon: '卵',
    imageSrc: '/egg.png',
    radius: 22,
    color: '#e8d080',
    highlightColor: '#fffaaa',
    shadowColor: '#a07820',
    glowColor: '#ffe060',
    borderColor: '#c8a030',
    iconColor: '#604010',
    iconGlow: '#ffe080',
    score: 1,
  },
  {
    id: 1,
    name: 'ポリン',
    icon: 'ポ',
    imageSrc: '/poring.png',
    radius: 30,
    color: '#ff80b0',
    highlightColor: '#ffb8d0',
    shadowColor: '#cc2060',
    glowColor: '#ff60a0',
    borderColor: '#cc4488',
    iconColor: '#fff',
    iconGlow: '#ffb8d0',
    score: 3,
  },
  {
    id: 2,
    name: 'ドロップス',
    icon: '滴',
    imageSrc: '/drops.png',
    radius: 38,
    color: '#60b8ff',
    highlightColor: '#a0d4ff',
    shadowColor: '#1050b0',
    glowColor: '#40a0ff',
    borderColor: '#2060d0',
    iconColor: '#fff',
    iconGlow: '#80d0ff',
    score: 6,
  },
  {
    id: 3,
    name: 'ポポリン',
    icon: 'ポポ',
    imageSrc: '/poporing.png',
    radius: 47,
    color: '#40d870',
    highlightColor: '#80ffa0',
    shadowColor: '#107830',
    glowColor: '#20c050',
    borderColor: '#10a040',
    iconColor: '#fff',
    iconGlow: '#60ff90',
    score: 10,
  },
  {
    id: 4,
    name: 'マリンスフィア',
    icon: '海',
    imageSrc: '/marinesphere.png',
    radius: 57,
    color: '#1080ff',
    highlightColor: '#60b0ff',
    shadowColor: '#002090',
    glowColor: '#0060ff',
    borderColor: '#0040d0',
    iconColor: '#c0e8ff',
    iconGlow: '#40a8ff',
    score: 15,
  },
  {
    id: 5,
    name: 'ゴーストリング',
    icon: '幽',
    imageSrc: '/ghostring.png',
    radius: 67,
    color: '#b060ff',
    highlightColor: '#d090ff',
    shadowColor: '#400090',
    glowColor: '#9030ff',
    borderColor: '#6020c0',
    iconColor: '#f0e0ff',
    iconGlow: '#c080ff',
    score: 21,
  },
  {
    id: 6,
    name: 'マスターリング',
    icon: '王',
    imageSrc: '/masterring.png',
    radius: 77,
    color: '#ff9020',
    highlightColor: '#ffc060',
    shadowColor: '#803000',
    glowColor: '#ff7000',
    borderColor: '#c05000',
    iconColor: '#fff8e0',
    iconGlow: '#ffb040',
    score: 28,
  },
  {
    id: 7,
    name: 'デビルリング',
    icon: '悪',
    imageSrc: '/deviling.png',
    radius: 88,
    color: '#ff2020',
    highlightColor: '#ff6060',
    shadowColor: '#800000',
    glowColor: '#ff0000',
    borderColor: '#aa0000',
    iconColor: '#ffe0e0',
    iconGlow: '#ff6060',
    score: 36,
  },
  {
    id: 8,
    name: 'エンジェリング',
    icon: '天',
    imageSrc: '/angeling.png',
    radius: 100,
    color: '#ffffff',
    highlightColor: '#ffffff',
    shadowColor: '#a0a0c0',
    glowColor: '#ffe0a0',
    borderColor: '#c0a030',
    iconColor: '#806000',
    iconGlow: '#ffe060',
    score: 45,
  },
  {
    id: 9,
    name: 'タオグンカ',
    icon: '鬼',
    imageSrc: '/taogunka.png',
    radius: 113,
    color: '#ff5000',
    highlightColor: '#ff8040',
    shadowColor: '#601000',
    glowColor: '#ff3000',
    borderColor: '#cc2000',
    iconColor: '#ffe0c0',
    iconGlow: '#ff7030',
    score: 55,
  },
  {
    id: 10,
    name: '知らない人',
    icon: '？',
    imageSrc: '/unknown.png',
    radius: 128,
    color: '#1a0030',
    highlightColor: '#4a0070',
    shadowColor: '#060010',
    glowColor: '#8000ff',
    borderColor: '#5000a0',
    iconColor: '#e0c0ff',
    iconGlow: '#a040ff',
    score: 0,
  },
];

// Global block-size scale (original size; frame2.png's wider field accommodates it).
const BLOCK_SCALE = 0.81;
for (const m of MONSTERS) m.radius = m.radius * BLOCK_SCALE;

export const MAX_LEVEL = MONSTERS.length - 1;
export const SPECIAL_MERGE_SCORE = 2000;

// Only levels 0-4 can appear as initial drops
export function getRandomStartLevel(): number {
  const rand = Math.random();
  if (rand < 0.25) return 0;  // 25% (was 35%)
  if (rand < 0.50) return 1;  // 25%
  if (rand < 0.72) return 2;  // 22% (was 20%)
  if (rand < 0.90) return 3;  // 18% (was 13%)
  return 4;                   // 10% (was 7%)
}
