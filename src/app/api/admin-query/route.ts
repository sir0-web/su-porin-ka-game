import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabaseAdmin'

const ADMIN_KEY = process.env.ADMIN_KEY

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }) }

  if (body.adminKey !== ADMIN_KEY)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const db = getSupabaseAdmin()
  if (!db) return NextResponse.json({ data: [], error: 'Supabase not configured' })

  const { action } = body

  if (action === 'rankings') {
    const search = String(body.search ?? '')
    let q = db.from('suiga_rankings').select('*').order('score', { ascending: false }).limit(100)
    if (search) q = q.ilike('name', `%${search}%`)
    const { data, error } = await q
    return NextResponse.json({ data: data ?? [], error: error?.message })
  }

  if (action === 'worldlogs') {
    const search = String(body.search ?? '')
    const typeFilter = String(body.typeFilter ?? '')
    let q = db.from('suiga_world_notifications').select('*').order('created_at', { ascending: false }).limit(200)
    if (search.trim()) q = q.ilike('player_name', `%${search.trim()}%`)
    if (typeFilter) q = q.eq('type', typeFilter)
    const { data, error } = await q
    return NextResponse.json({ data: data ?? [], error: error?.message })
  }

  if (action === 'blockstats') {
    const { data: bsData, error: bsErr } = await db
      .from('suiga_block_stats')
      .select('monster_id, total_merges')
      .order('monster_id')
    if (!bsErr && bsData && bsData.length > 0) {
      return NextResponse.json({ data: bsData })
    }
    // フォールバック: suiga_rankings.unknown_count を集計
    const { data: rkData } = await db.from('suiga_rankings').select('unknown_count')
    const total = (rkData ?? []).reduce(
      (s: number, r: { unknown_count: number }) => s + (Number(r.unknown_count) || 0), 0,
    )
    return NextResponse.json({ data: [{ monster_id: 10, total_merges: total }], fallback: true })
  }

  if (action === 'playerstats') {
    // suiga_rankings から端末(player_id)別プレイ回数・使用キャラ名を集計
    const { data: rows } = await db
      .from('suiga_rankings')
      .select('player_id, name, score, created_at')
      .not('player_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(2000)

    // suiga_active_sessions からオンライン中の player_id を取得
    const cutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString()
    const { data: online } = await db
      .from('suiga_active_sessions')
      .select('player_id, player_name, updated_at')
      .gte('updated_at', cutoff)
    const onlineSet = new Set((online ?? []).map((r: { player_id: string }) => r.player_id))

    type DeviceRow = { player_id: string; name: string; score: number; created_at: string }
    const map = new Map<string, { play_count: number; names: string[]; best_score: number; last_played: string; is_online: boolean }>()
    for (const r of (rows ?? []) as DeviceRow[]) {
      const pid = r.player_id
      if (!pid) continue
      const cur = map.get(pid) ?? { play_count: 0, names: [], best_score: 0, last_played: r.created_at, is_online: onlineSet.has(pid) }
      cur.play_count++
      if (!cur.names.includes(r.name)) cur.names.push(r.name)
      if (r.score > cur.best_score) cur.best_score = r.score
      if (r.created_at > cur.last_played) cur.last_played = r.created_at
      map.set(pid, cur)
    }

    const stats = Array.from(map.entries())
      .map(([player_id, s]) => ({ player_id, ...s }))
      .sort((a, b) => b.play_count - a.play_count)
    return NextResponse.json({ data: stats })
  }

  return NextResponse.json({ error: 'unknown action' }, { status: 400 })
}
