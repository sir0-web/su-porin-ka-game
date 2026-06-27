import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end()
  if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY 未設定' })

  const { adminKey, action } = req.body ?? {}
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  try {
    if (action === 'load') {
      const [{ data: winData }, { data: msgData }] = await Promise.all([
        db.from('suiga_system_config').select('value').eq('key', 'maintenance_windows').single(),
        db.from('suiga_system_config').select('value').eq('key', 'maintenance_message').single(),
      ])
      return res.json({ ok: true, windows: winData?.value ?? [], message: msgData?.value ?? null })
    }

    if (action === 'save_windows') {
      const { windows } = req.body
      const { error } = await db.from('suiga_system_config').upsert(
        { key: 'maintenance_windows', value: windows, updated_at: new Date().toISOString() }
      )
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true })
    }

    if (action === 'save_message') {
      const { heading, lead, note } = req.body
      const { error } = await db.from('suiga_system_config').upsert(
        { key: 'maintenance_message', value: { heading, lead, note }, updated_at: new Date().toISOString() }
      )
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true })
    }

    return res.status(400).json({ error: 'invalid action' })
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? String(e) })
  }
}
