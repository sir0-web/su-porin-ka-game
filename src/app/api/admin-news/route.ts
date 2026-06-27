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
    if (action === 'list') {
      const { data, error } = await db.from('suiga_announcements').select('*').order('published_at', { ascending: false }).limit(200)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, rows: data ?? [] })
    }

    if (action === 'create') {
      const { title, body_html, is_published, published_at } = body ?? {}
      if (!title || typeof title !== 'string') return NextResponse.json({ error: 'title 必須' }, { status: 400 })
      const { data, error } = await db.from('suiga_announcements').insert({
        title: title.slice(0, 200),
        body_html: typeof body_html === 'string' ? body_html : '',
        is_published: is_published !== false,
        published_at: published_at || new Date().toISOString(),
      }).select().single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, row: data })
    }

    if (action === 'update') {
      const { id, title, body_html, is_published, published_at } = body ?? {}
      if (!Number.isFinite(Number(id))) return NextResponse.json({ error: 'id 必須' }, { status: 400 })
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (typeof title === 'string')         patch.title = title.slice(0, 200)
      if (typeof body_html === 'string')     patch.body_html = body_html
      if (typeof is_published === 'boolean') patch.is_published = is_published
      if (published_at)                      patch.published_at = published_at
      const { data, error } = await db.from('suiga_announcements').update(patch).eq('id', Number(id)).select().single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, row: data })
    }

    if (action === 'delete') {
      const { id } = body ?? {}
      if (!Number.isFinite(Number(id))) return NextResponse.json({ error: 'id 必須' }, { status: 400 })
      const { error } = await db.from('suiga_announcements').delete().eq('id', Number(id))
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
