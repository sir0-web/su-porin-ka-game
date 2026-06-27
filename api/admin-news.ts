import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || 'https://ovutdzjddrwbguwjwmuw.supabase.co'
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

// お知らせの作成・編集・削除（ADMIN専用。adminKeyで保護）
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end()
  if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY 未設定' })

  const { adminKey, action } = req.body ?? {}
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  try {
    // 一覧（下書き含む全件。VIEW数確認用）
    if (action === 'list') {
      const { data, error } = await db
        .from('suiga_announcements')
        .select('*')
        .order('published_at', { ascending: false })
        .limit(200)
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true, rows: data ?? [] })
    }

    if (action === 'create') {
      const { title, body_html, is_published, published_at } = req.body ?? {}
      if (!title || typeof title !== 'string') return res.status(400).json({ error: 'title 必須' })
      const { data, error } = await db.from('suiga_announcements').insert({
        title: title.slice(0, 200),
        body_html: typeof body_html === 'string' ? body_html : '',
        is_published: is_published !== false,
        published_at: published_at || new Date().toISOString(),
      }).select().single()
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true, row: data })
    }

    if (action === 'update') {
      const { id, title, body_html, is_published, published_at } = req.body ?? {}
      if (!Number.isFinite(Number(id))) return res.status(400).json({ error: 'id 必須' })
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (typeof title === 'string')        patch.title = title.slice(0, 200)
      if (typeof body_html === 'string')    patch.body_html = body_html
      if (typeof is_published === 'boolean') patch.is_published = is_published
      if (published_at)                     patch.published_at = published_at
      const { data, error } = await db.from('suiga_announcements')
        .update(patch).eq('id', Number(id)).select().single()
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true, row: data })
    }

    if (action === 'delete') {
      const { id } = req.body ?? {}
      if (!Number.isFinite(Number(id))) return res.status(400).json({ error: 'id 必須' })
      const { error } = await db.from('suiga_announcements').delete().eq('id', Number(id))
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true })
    }

    return res.status(400).json({ error: 'invalid action' })
  } catch (e: any) {
    console.error('[admin-news] error:', e)
    return res.status(500).json({ error: e?.message ?? String(e) })
  }
}
