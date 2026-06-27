import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabaseAdmin'

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key')
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = getSupabaseAdmin()
  if (!db) return NextResponse.json({ error: 'supabaseAdmin returned null（URL/KEYが未設定）' })

  const [{ data: winData, error: e1 }, { data: msgData, error: e2 }] = await Promise.all([
    db.from('suiga_system_config').select('value').eq('key', 'maintenance_windows').single(),
    db.from('suiga_system_config').select('value').eq('key', 'maintenance_message').single(),
  ])

  const now = new Date()
  const windows = (winData?.value ?? []) as { start: string; end: string }[]
  const checks = windows.map(w => ({
    start: w.start,
    end: w.end,
    startParsed: new Date(w.start).toISOString(),
    endParsed: new Date(w.end).toISOString(),
    active: now >= new Date(w.start) && now <= new Date(w.end),
  }))

  return NextResponse.json({
    serverNow: now.toISOString(),
    winError: e1?.message ?? null,
    msgError: e2?.message ?? null,
    rawWindows: winData?.value,
    rawMessage: msgData?.value,
    checks,
    anyActive: checks.some(c => c.active),
  })
}
