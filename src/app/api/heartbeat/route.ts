import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabaseAdmin'

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }) }

  const player_id = String(body.player_id ?? '').trim().slice(0, 50)
  if (!player_id) return NextResponse.json({ error: 'missing player_id' }, { status: 400 })

  const db = getSupabaseAdmin()
  if (!db) return NextResponse.json({ ok: true }) // Supabase未設定時はno-op

  await db.from('suiga_active_sessions').upsert({
    player_id,
    player_name: String(body.player_name ?? '').slice(0, 30),
    floor: Math.max(0, Math.min(10, Number(body.floor) || 0)),
    updated_at: new Date().toISOString(),
  })

  return NextResponse.json({ ok: true })
}
