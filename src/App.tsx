import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { drawFirstFrame } from './decodeFirstFrame'
import type { FirstFrameInfo } from './decodeFirstFrame'

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<FirstFrameInfo | null>(null)

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setError(null)
    setInfo(null)

    const canvas = canvasRef.current
    if (!canvas) {
      setError('The canvas is not mounted.')
      return
    }

    try {
      setInfo(await drawFirstFrame(file, canvas))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div>
      <h1>First frame</h1>

      <p>
        <input type="file" accept="video/*" onChange={handleFileChange} />
      </p>

      {error !== null && <p style={{ color: 'red' }}>Error: {error}</p>}

      {info !== null && (
        <p>
          {info.width} x {info.height} - frame at {info.timestampMicros} us
        </p>
      )}

      <canvas ref={canvasRef} style={{ maxWidth: '100%' }} />
    </div>
  )
}
