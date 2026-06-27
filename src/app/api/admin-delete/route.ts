import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const ALLOWED_TABLES = ['suiga_rankings', 'suiga_world_notifications', 'suiga_reports']

export async function POST(req: NextRequest) {
  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }) }

  const { table, ids, adminKey } = body ?? {}

  const expectedKey = process.env.ADMIN_KEY
  if (!expectedKey || adminKey !== expectedKey)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!ALLOWED_TABLES.includes(table))
    return NextResponse.json({ error: 'Invalid table' }, { status: 400 })

  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id: unknown) => typeof id === 'number'))
    return NextResponse.json({ error: 'Invalid ids' }, { status: 400 })

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey)
    return NextResponse.json({ error: 'SUPABASE_SERVICE_ROLE_KEY が未設定' }, { status: 500 })

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  const { data, error } = await db.from(table).delete().in('id', ids).select()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ deleted: data?.length ?? 0 })
}
