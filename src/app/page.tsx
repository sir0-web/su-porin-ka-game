import Game from '@/components/Game';

export default function Page() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        background: 'linear-gradient(180deg, #06060f 0%, #0c0825 100%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '8px 0 0',
      }}
    >
      {/* Title bar */}
      <div
        style={{
          width: '100%',
          maxWidth: 400,
          padding: '6px 12px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          borderBottom: '1px solid #2a1e60',
          marginBottom: 4,
        }}
      >
        <span style={{ color: '#c8a030', fontSize: 10, letterSpacing: 2, fontWeight: 700 }}>
          ✦ RAGNAROK ORIGIN ✦
        </span>
      </div>

      <Game />

      {/* Footer */}
      <div
        style={{
          marginTop: 12,
          color: '#4a3a20',
          fontSize: 9,
          letterSpacing: 1,
          textAlign: 'center',
          paddingBottom: 8,
        }}
      >
        Inspired by Suika Game × Ragnarok Origin
      </div>
    </main>
  );
}
