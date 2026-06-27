import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || 'https://ovutdzjddrwbguwjwmuw.supabase.co'
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

// ADMIN側の双方向DM操作（service role 専用、adminKey 認証）。
//   action='send'   → 指定プレイヤーへDM送信(sender='admin')
//   action='inbox'  → プレイヤー返信の受信箱（スレッド一覧＋未読数）
//   action='thread' → 指定player_idの全メッセージ取得＋player発を既読化
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).end()
  if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY 未設定' })

  const { adminKey, action } = req.body ?? {}
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

    if (action === 'send') {
      const { to_player_id, to_player_name, title, body } = req.body ?? {}
      if (typeof to_player_id !== 'string' || !to_player_id.trim()) return res.status(400).json({ error: 'to_player_id 必須' })
      if (typeof title !== 'string' || !title.trim() || typeof body !== 'string' || !body.trim()) {
        return res.status(400).json({ error: 'title / body 必須' })
      }
      const { error } = await db.from('suiga_mails').insert({
        player_id: to_player_id.trim(),
        player_name: typeof to_player_name === 'string' ? to_player_name : null,
        sender: 'admin',
        title: title.trim(),
        body: body.trim(),
        read: false,
      })
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true })
    }

    if (action === 'inbox') {
      // プレイヤー返信を新しい順に取得し、player_idごとにスレッド集約（未読件数＋最新本文）。
      const { data, error } = await db.from('suiga_mails')
        .select('player_id, player_name, body, read, created_at')
        .eq('sender', 'player')
        .order('created_at', { ascending: false })
        .limit(500)
      if (error) return res.json({ threads: [], unread: 0 })
      const rows = data ?? []
      const map = new Map<string, any>()
      let unread = 0
      for (const r of rows) {
        if (!r.read) unread++
        const t = map.get(r.player_id)
        if (!t) {
          map.set(r.player_id, {
            player_id: r.player_id, player_name: r.player_name,
            last_body: r.body, last_at: r.created_at, unread: r.read ? 0 : 1,
          })
        } else if (!r.read) {
          t.unread++
        }
      }
      return res.json({ threads: Array.from(map.values()), unread })
    }

    if (action === 'thread') {
      const { player_id } = req.body ?? {}
      if (typeof player_id !== 'string' || !player_id.trim()) return res.status(400).json({ error: 'player_id 必須' })
      const pid = player_id.trim()
      const { data, error } = await db.from('suiga_mails')
        .select('id, sender, title, body, read, created_at')
        .eq('player_id', pid)
        .order('created_at', { ascending: true })
        .limit(200)
      if (error) return res.status(500).json({ error: error.message })
      // player発をADMINが既読化
      await db.from('suiga_mails').update({ read: true })
        .eq('player_id', pid).eq('sender', 'player').eq('read', false)
      return res.json({ messages: data ?? [] })
    }

    return res.status(400).json({ error: 'invalid action' })
  } catch (e: any) {
    console.error('[admin-mail] error:', e)
    return res.status(500).json({ error: e?.message ?? String(e) })
  }
}
