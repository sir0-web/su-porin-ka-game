import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

export async function POST(req: NextRequest) {
  if (!SERVICE_KEY) return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY 未設定' }, { status: 500 })

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }) }

  const { adminKey, action } = body ?? {}
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  try {
    if (action === 'load') {
      const [{ data: winData }, { data: msgData }] = await Promise.all([
        db.from('suiga_system_config').select('value').eq('key', 'maintenance_windows').single(),
        db.from('suiga_system_config').select('value').eq('key', 'maintenance_message').single(),
      ])
      return NextResponse.json({ ok: true, windows: winData?.value ?? [], message: msgData?.value ?? null })
    }

    if (action === 'save_windows') {
      const { windows } = body
      const { error } = await db.from('suiga_system_config').upsert(
        { key: 'maintenance_windows', value: windows, updated_at: new Date().toISOString() }
      )
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    if (action === 'save_message') {
      const { heading, lead, note } = body
      const { error } = await db.from('suiga_system_config').upsert(
        { key: 'maintenance_message', value: { heading, lead, note }, updated_at: new Date().toISOString() }
      )
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
