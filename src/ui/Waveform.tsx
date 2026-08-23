import { useEffect, useRef } from 'react'

export type WaveformProps = {
  /** Loudest sample in each bucket, from 0 to 1, for the WHOLE source. */
  peaks: Float32Array
  bucketsPerSecond: number
  /** The slice of the source this block shows. */
  sourceInMicros: number
  sourceOutMicros: number
  width: number
  height: number
}

/**
 * The waveform of the part of a source a block is showing.
 *
 * Drawn to a canvas rather than as an SVG path: a three minute song is nine
 * thousand buckets, and that many DOM nodes on a timeline that re-renders on
 * every zoom is not a trade worth making. The canvas is redrawn only when the
 * peaks, the slice or the size actually change.
 *
 * The peaks belong to the source, not to the segment, so trimming a block
 * re-slices the same measurements instead of asking for new ones.
 */
export default function Waveform({
  peaks,
  bucketsPerSecond,
  sourceInMicros,
  sourceOutMicros,
  width,
  height,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const context = canvas.getContext('2d')
    if (!context) return

    context.clearRect(0, 0, canvas.width, canvas.height)
    if (peaks.length === 0 || width <= 0 || height <= 0) return

    const firstBucket = (sourceInMicros / 1e6) * bucketsPerSecond
    const lastBucket = (sourceOutMicros / 1e6) * bucketsPerSecond
    const span = lastBucket - firstBucket
    if (span <= 0) return

    const middle = canvas.height / 2
    context.fillStyle = 'rgba(255, 255, 255, 0.55)'

    // One column per device pixel, each the loudest bucket it covers, so the
    // shape does not change as the timeline is zoomed.
    for (let column = 0; column < canvas.width; column++) {
      const from = firstBucket + (span * column) / canvas.width
      const to = firstBucket + (span * (column + 1)) / canvas.width

      let loudest = 0
      const start = Math.max(0, Math.floor(from))
      const end = Math.min(peaks.length - 1, Math.max(start, Math.ceil(to) - 1))
      for (let bucket = start; bucket <= end; bucket++) {
        const value = peaks[bucket]
        if (value !== undefined && value > loudest) loudest = value
      }

      // At least a hairline, so a quiet passage still reads as audio rather
      // than as a gap in the block.
      const half = Math.max(0.5, loudest * middle)
      context.fillRect(column, middle - half, 1, half * 2)
    }
  }, [peaks, bucketsPerSecond, sourceInMicros, sourceOutMicros, width, height])

  return (
    <canvas
      ref={canvasRef}
      className="timeline-waveform"
      data-testid="waveform"
      width={Math.max(1, Math.round(width))}
      height={Math.max(1, Math.round(height))}
    />
  )
}
