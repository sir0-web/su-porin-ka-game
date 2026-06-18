import { ImageResponse } from 'next/og';

export const runtime = 'edge';
export const alt = 'スイガゲーム';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #060612 0%, #1a0a2e 50%, #0a0a1a 100%)',
          fontFamily: 'sans-serif',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* 背景の装飾円 */}
        <div
          style={{
            position: 'absolute',
            width: 500,
            height: 500,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(180,120,255,0.15) 0%, transparent 70%)',
            top: -100,
            right: -100,
            display: 'flex',
          }}
        />
        <div
          style={{
            position: 'absolute',
            width: 400,
            height: 400,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(80,180,255,0.1) 0%, transparent 70%)',
            bottom: -80,
            left: -80,
            display: 'flex',
          }}
        />

        {/* タイトル */}
        <div
          style={{
            fontSize: 120,
            fontWeight: 700,
            color: '#ffffff',
            letterSpacing: '-2px',
            textShadow: '0 0 40px rgba(200,150,255,0.8), 0 0 80px rgba(200,150,255,0.4)',
            display: 'flex',
          }}
        >
          スイガゲーム
        </div>

        {/* サブタイトル */}
        <div
          style={{
            fontSize: 36,
            color: 'rgba(200,180,255,0.85)',
            marginTop: 24,
            letterSpacing: '6px',
            display: 'flex',
          }}
        >
          ROモンスター合体パズル
        </div>

        {/* モンスターアイコン風の装飾 */}
        <div
          style={{
            display: 'flex',
            gap: 20,
            marginTop: 48,
          }}
        >
          {['🟣', '🔵', '🟠', '🔴', '⚫'].map((c, i) => (
            <div
              key={i}
              style={{
                width: 60,
                height: 60,
                borderRadius: '50%',
                background: `rgba(255,255,255,0.${i + 1})`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 28,
                boxShadow: '0 0 20px rgba(180,120,255,0.5)',
              }}
            >
              {c}
            </div>
          ))}
        </div>
      </div>
    ),
    { ...size }
  );
}
