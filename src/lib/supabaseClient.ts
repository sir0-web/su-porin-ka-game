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

export function getSupabaseBrowser(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    cached = null;
    return null;
  }
  try {
    cached = createClient(url, key, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 20 } },
    });
  } catch {
    cached = null;
  }
  return cached;
}

export function isOnlineConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
