import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabaseAdmin'

const VALID_CATEGORIES = ['要望', '不具合報告', '質問', 'その他']

export async function POST(req: NextRequest) {
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }) }

  const { category, content, player_name } = body ?? {}
  if (!content?.trim()) return NextResponse.json({ error: 'content is required' }, { status: 400 })

  const db = getSupabaseAdmin()
  if (!db) return NextResponse.json({ error: 'DB not configured' }, { status: 500 })

  const { error } = await db.from('suiga_reports').insert({
    category: VALID_CATEGORIES.includes(category) ? category : 'その他',
    content: String(content).trim().slice(0, 2000),
    player_name: player_name?.trim()?.slice(0, 64) || null,
    status: 'new',
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
