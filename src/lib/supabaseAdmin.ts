import { createClient } from '@supabase/supabase-js';

// Server-only client using the service_role key. Returns null when the
// env vars are not configured so callers can fall back to local storage
// instead of crashing.
export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
