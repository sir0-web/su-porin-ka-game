import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || 'https://ovutdzjddrwbguwjwmuw.supabase.co'
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

const CATEGORIES = ['monster_normal', 'monster_mini', 'monster_mvp', 'monster_area', 'equip', 'item', 'spell']

// ゲームデータの上書き（データベース編集）。ADMIN専用・下書き/公開モデル。
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end()
  if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY 未設定' })

  const { adminKey, action } = req.body ?? {}
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

  try {
    // 全上書き行（下書き含む）を返す
    if (action === 'list') {
      const { data, error } = await db.from('suiga_data_overrides').select('*')
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true, rows: data ?? [] })
    }

    // 下書き保存（公開中の値はそのまま＝ライブを乱さない）
    if (action === 'save') {
      const { category, ref, patch, image } = req.body ?? {}
      if (!CATEGORIES.includes(category) || typeof ref !== 'string' || !ref) {
        return res.status(400).json({ error: 'category / ref が不正' })
      }
      const { error } = await db.from('suiga_data_overrides').upsert({
        category, ref,
        draft_patch: patch && typeof patch === 'object' ? patch : {},
        draft_image: typeof image === 'string' ? image : null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'category,ref' })
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true })
    }

    // 公開：下書きをライブへ反映
    if (action === 'publish') {
      const { category, ref } = req.body ?? {}
      const { data: cur, error: e1 } = await db.from('suiga_data_overrides')
        .select('draft_patch, draft_image').eq('category', category).eq('ref', ref).single()
      if (e1) return res.status(404).json({ error: e1.message })
      const { error } = await db.from('suiga_data_overrides').update({
        pub_patch: cur?.draft_patch ?? {},
        pub_image: cur?.draft_image ?? null,
        is_published: true,
        updated_at: new Date().toISOString(),
      }).eq('category', category).eq('ref', ref)
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true })
    }

    // 非公開：ライブ反映を停止（デフォルト値に戻る）
    if (action === 'unpublish') {
      const { category, ref } = req.body ?? {}
      const { error } = await db.from('suiga_data_overrides')
        .update({ is_published: false, updated_at: new Date().toISOString() })
        .eq('category', category).eq('ref', ref)
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true })
    }

    // 削除：上書きを完全に消す（デフォルトに戻る）
    if (action === 'delete') {
      const { category, ref } = req.body ?? {}
      const { error } = await db.from('suiga_data_overrides')
        .delete().eq('category', category).eq('ref', ref)
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true })
    }

    return res.status(400).json({ error: 'invalid action' })
  } catch (e: any) {
    console.error('[admin-data] error:', e)
    return res.status(500).json({ error: e?.message ?? String(e) })
  }
}
