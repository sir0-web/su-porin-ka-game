import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabaseAdmin'

export async function GET(req: NextRequest) {
  const db = getSupabaseAdmin()
  if (!db) return NextResponse.json({ data: [] })

  const since = req.nextUrl.searchParams.get('since')

  let q = db
    .from('suiga_world_notifications')
    .select('id, type, title, message, display_ms, created_at')
    .eq('player_id', 'admin-broadcast')
    .order('created_at', { ascending: true })
    .limit(5)

  if (since) {
    q = q.gt('created_at', since)
  } else {
    // 初回：直近2分以内のものだけ返す
    const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    q = q.gte('created_at', cutoff)
  }

  const { data, error } = await q
  if (error) return NextResponse.json({ data: [] })
  return NextResponse.json({ data: data ?? [] })
}
