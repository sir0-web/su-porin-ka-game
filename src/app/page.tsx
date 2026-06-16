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
        padding: '4px 0 0',
      }}
    >
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
      </div>
    </main>
  );
}
