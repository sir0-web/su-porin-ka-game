import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || 'https://ovutdzjddrwbguwjwmuw.supabase.co'
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

const STATUSES = ['new', 'read', 'done']

// 報告BOXのステータス更新・削除（ADMIN専用・service keyでRLSをbypass）
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end()
  if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY 未設定' })

  const { adminKey, action } = req.body ?? {}
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  try {
    if (action === 'set_status') {
      const id = Number(req.body?.id)
      const status = req.body?.status
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'id 必須' })
      if (!STATUSES.includes(status)) return res.status(400).json({ error: 'invalid status' })
      const { error } = await db.from('suiga_reports').update({ status }).eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true })
    }

    if (action === 'delete') {
      const ids = req.body?.ids
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((x: unknown) => typeof x === 'number')) {
        return res.status(400).json({ error: 'ids 必須（数値配列）' })
      }
      const { data, error } = await db.from('suiga_reports').delete().in('id', ids).select()
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true, deleted: data?.length ?? 0 })
    }

    return res.status(400).json({ error: 'invalid action' })
  } catch (e: any) {
    console.error('[admin-report] error:', e)
    return res.status(500).json({ error: e?.message ?? String(e) })
  }
}
