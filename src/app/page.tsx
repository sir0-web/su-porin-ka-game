import GameRoot from '@/components/GameRoot';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

// 常に最新のメンテ状態を返す（キャッシュ無効）
export const dynamic = 'force-dynamic';

interface MaintenanceWindow { from: number; to: number | null }
interface MaintenanceMessage { heading?: string; lead?: string; note?: string }

async function getMaintenanceState(): Promise<{ active: boolean; message: MaintenanceMessage }> {
  try {
    const db = getSupabaseAdmin();
    if (!db) return { active: true, message: {} };
    const [{ data: winData }, { data: msgData }] = await Promise.all([
      db.from('suiga_system_config').select('value').eq('key', 'maintenance_windows').single(),
      db.from('suiga_system_config').select('value').eq('key', 'maintenance_message').maybeSingle(),
    ]);
    const windows = (winData?.value ?? []) as MaintenanceWindow[];
    const message = (msgData?.value ?? {}) as MaintenanceMessage;
    const now = Date.now();
    // ウィンドウが1件でも「現在オープン中」なら公開、それ以外はメンテ
    const isOpen = windows.some(w => now >= w.from && (w.to === null || now < w.to));
    return { active: !isOpen, message };
  } catch {
    return { active: true, message: {} };
  }
}

const mainStyle: React.CSSProperties = {
  minHeight: '100dvh',
  backgroundColor: '#06060f',
  backgroundImage: 'url(/background.png)',
  backgroundSize: 'cover',
  backgroundPosition: 'center',
  backgroundRepeat: 'no-repeat',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
};

export default async function Page() {
  const { active, message } = await getMaintenanceState();

  if (active) {
    return (
      <main style={mainStyle}>
        <div style={{
          background: 'rgba(6,6,15,0.92)',
          border: '1px solid #3a2a60',
          borderRadius: 16,
          padding: '48px 40px',
          maxWidth: 420,
          textAlign: 'center',
          color: '#e0d8ff',
          fontFamily: "'Noto Sans JP', sans-serif",
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🔧</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12, color: '#c8b4ff' }}>
            {message.heading || 'メンテナンス中'}
          </h1>
          {message.lead && (
            <p style={{ fontSize: 14, lineHeight: 1.7, marginBottom: 8, whiteSpace: 'pre-wrap' }}>
              {message.lead}
            </p>
          )}
          {message.note && (
            <p style={{ fontSize: 12, color: '#9080c0', whiteSpace: 'pre-wrap', marginTop: 12 }}>
              {message.note}
            </p>
          )}
        </div>
      </main>
    );
  }

  return (
    <main style={mainStyle}>
      <GameRoot />
      <div style={{
        marginTop: 12,
        color: '#4a3a20',
        fontSize: 9,
        letterSpacing: 1,
        textAlign: 'center',
        paddingBottom: 8,
      }} />
    </main>
  );
}
