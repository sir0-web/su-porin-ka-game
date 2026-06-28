import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabaseAdmin'

const ADMIN_KEY = process.env.ADMIN_KEY
const ONLINE_TTL_MS = 3 * 60 * 1000 // 3分以内に心拍があれば「オンライン」

export async function GET() {
  const db = getSupabaseAdmin()
  if (!db) return NextResponse.json({ players: [] })

  const cutoff = new Date(Date.now() - ONLINE_TTL_MS).toISOString()
  const { data } = await db
    .from('suiga_active_sessions')
    .select('player_id, player_name, floor, updated_at')
    .gte('updated_at', cutoff)
    .order('updated_at', { ascending: false })

  return NextResponse.json({ players: data ?? [] })
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }) }

  if (body.adminKey !== ADMIN_KEY)
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const db = getSupabaseAdmin()
  if (!db) return NextResponse.json({ sessions: [] })

  if (body.action === 'player_state') {
    const name = String(body.name ?? '')
    const { data } = await db
      .from('suiga_active_sessions')
      .select('*')
      .ilike('player_name', `%${name}%`)
    return NextResponse.json({ sessions: data ?? [] })
  }

  return NextResponse.json({ ok: true })
}
