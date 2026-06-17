import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
import { MAX_LEVEL } from '@/lib/monsters';

const MAX_SCORE = 1_000_000;

interface RankEntry { name: string; score: number; maxLevel: number; }

async function topTen(): Promise<RankEntry[]> {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error('Supabase is not configured');
  const { data, error } = await supabase
    .from('rankings')
    .select('name, score, max_level')
    .order('score', { ascending: false })
    .limit(10);
  if (error) throw error;
  return (data ?? []).map((r) => ({ name: r.name, score: r.score, maxLevel: r.max_level }));
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

  if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
    return NextResponse.json({ error: 'invalid score' }, { status: 400 });
  }
  if (!Number.isInteger(maxLevel) || maxLevel < 0 || maxLevel > MAX_LEVEL) {
    return NextResponse.json({ error: 'invalid maxLevel' }, { status: 400 });
  }

  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) throw new Error('Supabase is not configured');
    const { error } = await supabase
      .from('rankings')
      .insert({ name, score, max_level: maxLevel });
    if (error) throw error;
    return NextResponse.json(await topTen());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
