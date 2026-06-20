'use client';

import { useState } from 'react';
import Game from '@/components/Game';
import BattleGame from '@/components/BattleGame';

// Top-level mode switch: the solo game's TOP menu has a 対戦モード button
// that flips us into the battle component (full-screen landscape).
export default function GameRoot() {
  const [mode, setMode] = useState<'solo' | 'battle'>('solo');
  if (mode === 'battle') return <BattleGame onExit={() => setMode('solo')} />;
  return <Game onBattle={() => setMode('battle')} />;
}
