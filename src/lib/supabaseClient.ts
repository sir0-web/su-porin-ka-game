'use client';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Browser-side Supabase client (anon key) used ONLY for Realtime
// (Presence + Broadcast) in the battle mode. Returns null when the
// public env vars are not configured, so the battle mode can fall
// back to an offline / CPU-only experience instead of crashing.
//
// Required env (e.g. Vercel project settings + local .env.local):
//   NEXT_PUBLIC_SUPABASE_URL
//   NEXT_PUBLIC_SUPABASE_ANON_KEY

let cached: SupabaseClient | null | undefined;

// A real anon/publishable key is long (legacy JWT ~150+ chars, new
// `sb_publishable_...` ~40+). Reject empty values and obvious
// placeholders so a not-yet-filled key falls back to offline instead of
// trying (and failing) to connect online.
function validKey(k: string | undefined): k is string {
  return typeof k === 'string' && k.trim().length >= 30 && !/[ぁ-んァ-ヶ一-龠]/.test(k);
}

export function getSupabaseBrowser(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !validKey(key)) {
    cached = null;
    return null;
  }
  try {
    cached = createClient(url, key, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 50 } },
    });
  } catch {
    cached = null;
  }
  return cached;
}

export function isOnlineConfigured(): boolean {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && validKey(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
