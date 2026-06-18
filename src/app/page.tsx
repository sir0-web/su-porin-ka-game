import Game from '@/components/Game';

export default function Page() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        // Full-screen background image (covers the area outside the play
        // area too). Falls back to a dark colour if the image is missing.
        backgroundColor: '#06060f',
        backgroundImage: 'url(/background.png)',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
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
