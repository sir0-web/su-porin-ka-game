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

  const now = Date.now()
  const windows = (winData?.value ?? []) as { from: number; to: number | null }[]
  const checks = windows.map(w => ({
    from: w.from, to: w.to,
    fromISO: new Date(w.from).toISOString(),
    toISO: w.to ? new Date(w.to).toISOString() : null,
    isOpen: now >= w.from && (w.to === null || now < w.to),
  }))
  const isOpen = checks.some(c => c.isOpen)

  return NextResponse.json({
    serverNow: new Date(now).toISOString(),
    winError: e1?.message ?? null,
    msgError: e2?.message ?? null,
    rawWindows: winData?.value,
    rawMessage: msgData?.value,
    checks,
    isOpen,
    inMaintenance: !isOpen,
  })
}
