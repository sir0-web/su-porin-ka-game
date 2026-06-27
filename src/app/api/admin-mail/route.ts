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
    if (action === 'send') {
      const { to_player_id, to_player_name, title, body: msgBody } = body ?? {}
      if (typeof to_player_id !== 'string' || !to_player_id.trim())
        return NextResponse.json({ error: 'to_player_id 必須' }, { status: 400 })
      if (typeof title !== 'string' || !title.trim() || typeof msgBody !== 'string' || !msgBody.trim())
        return NextResponse.json({ error: 'title / body 必須' }, { status: 400 })
      const { error } = await db.from('suiga_mails').insert({
        player_id: to_player_id.trim(),
        player_name: typeof to_player_name === 'string' ? to_player_name : null,
        sender: 'admin', title: title.trim(), body: msgBody.trim(), read: false,
      })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    if (action === 'inbox') {
      const { data, error } = await db.from('suiga_mails')
        .select('player_id, player_name, body, read, created_at')
        .eq('sender', 'player').order('created_at', { ascending: false }).limit(500)
      if (error) return NextResponse.json({ threads: [], unread: 0 })
      const rows = data ?? []
      const map = new Map<string, any>()
      let unread = 0
      for (const r of rows) {
        if (!r.read) unread++
        const t = map.get(r.player_id)
        if (!t) {
          map.set(r.player_id, {
            player_id: r.player_id, player_name: r.player_name,
            last_body: r.body, last_at: r.created_at, unread: r.read ? 0 : 1,
          })
        } else if (!r.read) { t.unread++ }
      }
      return NextResponse.json({ threads: Array.from(map.values()), unread })
    }

    if (action === 'thread') {
      const { player_id } = body ?? {}
      if (typeof player_id !== 'string' || !player_id.trim())
        return NextResponse.json({ error: 'player_id 必須' }, { status: 400 })
      const pid = player_id.trim()
      const { data, error } = await db.from('suiga_mails')
        .select('id, sender, title, body, read, created_at')
        .eq('player_id', pid).order('created_at', { ascending: true }).limit(200)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      await db.from('suiga_mails').update({ read: true })
        .eq('player_id', pid).eq('sender', 'player').eq('read', false)
      return NextResponse.json({ messages: data ?? [] })
    }

    return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
