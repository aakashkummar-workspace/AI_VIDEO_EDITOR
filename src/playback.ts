import type { Rotation } from 'mediabunny'

export const MICROS_PER_SECOND = 1_000_000

/** Sink boundary: mediabunny speaks seconds as floats, we speak integer microseconds. */
export function microsToSeconds(micros: number): number {
  return micros / MICROS_PER_SECOND
}

/** Sink boundary: seconds from mediabunny back into our integer microseconds. */
export function secondsToMicros(seconds: number): number {
  return Math.round(seconds * MICROS_PER_SECOND)
}

/**
 * Extracts a transferable VideoFrame from a mediabunny VideoSample and closes
 * the sample. The returned frame has its own lifetime and must be closed by
 * whoever ends up owning it.
 */
export function takeFrame(sample: {
  toVideoFrame(): VideoFrame
  close(): void
}): VideoFrame {
  try {
    return sample.toVideoFrame()
  } finally {
    sample.close()
  }
}

/**
 * Chooses which buffered frame to show at `targetMicros`: the newest frame at
 * or before the target. Anything older than that is late and gets dropped, so
 * playback follows the wall clock instead of the monitor refresh rate.
 *
 * Returns `drawIndex: -1` when every buffered frame is still in the future.
 */
export function selectFrame(
  buffer: readonly { timestampMicros: number }[],
  targetMicros: number,
): { drawIndex: number; dropCount: number } {
  let drawIndex = -1

  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i]!.timestampMicros > targetMicros) break
    drawIndex = i
  }

  return { drawIndex, dropCount: drawIndex < 0 ? 0 : drawIndex }
}

/**
 * Draws a frame to fill a canvas of `width` x `height` display pixels.
 *
 * A VideoFrame from mediabunny carries no rotation metadata (display
 * dimensions are pre-rotation), so the track rotation is applied here.
 */
export function drawFrame(
  context: CanvasRenderingContext2D,
  frame: CanvasImageSource,
  width: number,
  height: number,
  rotation: Rotation,
): void {
  context.save()

  switch (rotation) {
    case 90:
      context.translate(width, 0)
      context.rotate(Math.PI / 2)
      context.drawImage(frame, 0, 0, height, width)
      break
    case 180:
      context.translate(width, height)
      context.rotate(Math.PI)
      context.drawImage(frame, 0, 0, width, height)
      break
    case 270:
      context.translate(0, height)
      context.rotate(-Math.PI / 2)
      context.drawImage(frame, 0, 0, height, width)
      break
    default:
      context.drawImage(frame, 0, 0, width, height)
  }

  context.restore()
}

/** Formats microseconds as m:ss.hh for the time display. */
export function formatMicros(micros: number): string {
  const totalMillis = Math.max(0, Math.round(micros / 1000))
  const minutes = Math.floor(totalMillis / 60_000)
  const seconds = Math.floor((totalMillis % 60_000) / 1000)
  const hundredths = Math.floor((totalMillis % 1000) / 10)

  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`
}
