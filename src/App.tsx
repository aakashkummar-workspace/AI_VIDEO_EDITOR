import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { createPlayer, type LoadedInfo } from './player'
import { formatMicros } from './playback'

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<ReturnType<typeof createPlayer> | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<LoadedInfo | null>(null)
  const [currentMicros, setCurrentMicros] = useState(0)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const player = createPlayer(canvas, {
      onLoaded: setInfo,
      onTime: setCurrentMicros,
      onPlayingChange: setPlaying,
      onError: setError,
    })
    playerRef.current = player

    return () => {
      player.destroy()
      playerRef.current = null
    }
  }, [])

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setError(null)
    setInfo(null)
    setCurrentMicros(0)
    playerRef.current?.load(file)
  }

  return (
    <div>
      <h1>Playback</h1>

      <p>
        <input type="file" accept="video/*" onChange={handleFileChange} />
      </p>

      <p>
        <button
          type="button"
          onClick={() => playerRef.current?.play()}
          disabled={info === null || playing}
        >
          Play
        </button>{' '}
        <button
          type="button"
          onClick={() => playerRef.current?.pause()}
          disabled={!playing}
        >
          Pause
        </button>{' '}
        <span>
          {formatMicros(currentMicros)} /{' '}
          {formatMicros(info?.durationMicros ?? 0)}
        </span>
      </p>

      {error !== null && <p style={{ color: 'red' }}>Error: {error}</p>}

      {info !== null && (
        <p>
          {info.width} x {info.height}
        </p>
      )}

      <canvas ref={canvasRef} style={{ maxWidth: '100%' }} />
    </div>
  )
}
