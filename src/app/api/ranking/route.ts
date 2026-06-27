import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { MAX_LEVEL } from '@/lib/monsters';

const MAX_SCORE = 1_000_000;

interface RankEntry { name: string; score: number; maxLevel: number; unknown?: number; }

type RankRow = { name: string; score: number; max_level: number; unknown_count?: number };

async function topTen(): Promise<RankEntry[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error('Supabase is not configured');
  // Prefer selecting unknown_count; gracefully fall back if the column
  // hasn't been added to the table yet.
  let rows: RankRow[];
  const withCol = await supabase
    .from('suiga_rankings')
    .select('name, score, max_level, unknown_count')
    .order('score', { ascending: false })
    .limit(10);
  if (withCol.error) {
    const base = await supabase
      .from('suiga_rankings')
      .select('name, score, max_level')
      .order('score', { ascending: false })
      .limit(10);
    if (base.error) throw base.error;
    rows = (base.data ?? []) as unknown as RankRow[];
  } else {
    rows = (withCol.data ?? []) as unknown as RankRow[];
  }
  return rows.map((r) => ({
    name: r.name, score: r.score, maxLevel: r.max_level,
    unknown: r.unknown_count ?? undefined,
  }));
}

export async function GET() {
  try {
    return NextResponse.json(await topTen());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  const name = (typeof b.name === 'string' ? b.name.trim().slice(0, 10) : '') || 'ぼうけんしゃ';
  const score = Number(b.score);
  const maxLevel = Number(b.maxLevel);
  const unknownRaw = Number(b.unknown);
  const unknown = Number.isInteger(unknownRaw) && unknownRaw >= 0 && unknownRaw < 1000 ? unknownRaw : 0;

  if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
    return NextResponse.json({ error: 'invalid score' }, { status: 400 });
  }
  if (!Number.isInteger(maxLevel) || maxLevel < 0 || maxLevel > MAX_LEVEL) {
    return NextResponse.json({ error: 'invalid maxLevel' }, { status: 400 });
  }

  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) throw new Error('Supabase is not configured');
    // Try storing unknown_count; if the column doesn't exist yet, retry
    // without it so submissions never fail.
    let ins = await supabase
      .from('suiga_rankings')
      .insert({ name, score, max_level: maxLevel, unknown_count: unknown });
    if (ins.error) {
      ins = await supabase
        .from('suiga_rankings')
        .insert({ name, score, max_level: maxLevel });
      if (ins.error) throw ins.error;
    }
    return NextResponse.json(await topTen());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
