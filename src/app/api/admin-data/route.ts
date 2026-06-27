import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
const CATEGORIES   = ['monster_normal', 'monster_mini', 'monster_mvp', 'monster_area', 'equip', 'item', 'spell']

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
      const { data, error } = await db.from('suiga_data_overrides').select('*')
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true, rows: data ?? [] })
    }

    if (action === 'save') {
      const { category, ref, patch, image } = body ?? {}
      if (!CATEGORIES.includes(category) || typeof ref !== 'string' || !ref)
        return NextResponse.json({ error: 'category / ref が不正' }, { status: 400 })
      const { error } = await db.from('suiga_data_overrides').upsert({
        category, ref,
        draft_patch: patch && typeof patch === 'object' ? patch : {},
        draft_image: typeof image === 'string' ? image : null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'category,ref' })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    if (action === 'publish') {
      const { category, ref } = body ?? {}
      const { data: cur, error: e1 } = await db.from('suiga_data_overrides')
        .select('draft_patch, draft_image').eq('category', category).eq('ref', ref).single()
      if (e1) return NextResponse.json({ error: e1.message }, { status: 404 })
      const { error } = await db.from('suiga_data_overrides').update({
        pub_patch: cur?.draft_patch ?? {},
        pub_image: cur?.draft_image ?? null,
        is_published: true,
        updated_at: new Date().toISOString(),
      }).eq('category', category).eq('ref', ref)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    if (action === 'unpublish') {
      const { category, ref } = body ?? {}
      const { error } = await db.from('suiga_data_overrides')
        .update({ is_published: false, updated_at: new Date().toISOString() })
        .eq('category', category).eq('ref', ref)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    if (action === 'delete') {
      const { category, ref } = body ?? {}
      const { error } = await db.from('suiga_data_overrides')
        .delete().eq('category', category).eq('ref', ref)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 })
  }
}
