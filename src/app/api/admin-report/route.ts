import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
const STATUSES     = ['new', 'read', 'done']

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
      const { status, category } = body ?? {}
      let q = db.from('suiga_reports').select('*').order('created_at', { ascending: false }).limit(300)
      if (status) q = q.eq('status', status)
      if (category) q = q.eq('category', category)
      const { data, error } = await q
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ rows: data ?? [] })
    }

    if (action === 'set_status') {
      const id = Number(body?.id)
      const status = body?.status
      if (!Number.isFinite(id)) return NextResponse.json({ error: 'id 必須' }, { status: 400 })
      if (!STATUSES.includes(status)) return NextResponse.json({ error: 'invalid status' }, { status: 400 })
      const { error } = await db.from('suiga_reports').update({ status }).eq('id', id)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    if (action === 'delete') {
      const ids = body?.ids
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x: unknown) => typeof x === 'number')) {
        return NextResponse.json({ error: 'ids 必須（数値配列）' }, { status: 400 })
      }
      const { data, error } = await db.from('suiga_reports').delete().in('id', ids).select()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, deleted: data?.length ?? 0 })
    }

    return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
