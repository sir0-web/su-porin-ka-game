import { createClient } from '@supabase/supabase-js'

// 'rankings'(プレフィックスなし)は別ゲームのテーブルなので許可しない（誤削除防止）
const ALLOWED_TABLES = ['suiga_rankings', 'suiga_world_notifications', 'suiga_reports']

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end()

  const { table, ids, adminKey } = req.body ?? {}

  const expectedKey = process.env.ADMIN_KEY
  if (!expectedKey || adminKey !== expectedKey)
    return res.status(401).json({ error: 'Unauthorized' })

  if (!ALLOWED_TABLES.includes(table))
    return res.status(400).json({ error: 'Invalid table' })

  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id: unknown) => typeof id === 'number'))
    return res.status(400).json({ error: 'Invalid ids' })

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey)
    return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY が Vercel 環境変数に未設定です' })

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || 'https://ovutdzjddrwbguwjwmuw.supabase.co'
  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  })

  const { data, error } = await db.from(table).delete().in('id', ids).select()

  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ deleted: data?.length ?? 0 })
}
