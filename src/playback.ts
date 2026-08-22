import { clipAt, overlaysAt } from './timeline/operations'
import {
  OVERLAY_FONT_FAMILY,
  type Overlay,
  type Project,
  type Rotation,
} from './timeline/types'

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
  buffer: readonly { timelineMicros: number }[],
  targetMicros: number,
): { drawIndex: number; dropCount: number } {
  let drawIndex = -1

  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i]!.timelineMicros > targetMicros) break
    drawIndex = i
  }

  return { drawIndex, dropCount: drawIndex < 0 ? 0 : drawIndex }
}

/** Any 2D context: a preview canvas on the UI thread, or an OffscreenCanvas in a worker. */
export type RenderContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D

/** Where a source of these dimensions sits inside the composition. */
export type FitRect = { x: number; y: number; width: number; height: number }

/**
 * Fits a source into the composition without distorting it: scaled to the
 * larger of the two constraints and centred, so the leftover is even margin on
 * one axis. Never stretches, never crops.
 */
export function fitRect(
  sourceWidth: number,
  sourceHeight: number,
  compositionWidth: number,
  compositionHeight: number,
): FitRect {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }

  const scale = Math.min(
    compositionWidth / sourceWidth,
    compositionHeight / sourceHeight,
  )
  const width = Math.round(sourceWidth * scale)
  const height = Math.round(sourceHeight * scale)

  return {
    x: Math.round((compositionWidth - width) / 2),
    y: Math.round((compositionHeight - height) / 2),
    width,
    height,
  }
}

/**
 * THE render function. Given the project and a position on the timeline, paints
 * exactly what should be on screen at that moment.
 *
 * Both the preview and the export call this and nothing else. If they ever
 * diverge here, the golden-frame test fails, and that is the point.
 *
 * The composition is always cleared to black first, so a gap, a frame that
 * failed to decode, and the letterbox bars beside a source of a different
 * shape are all the same thing: black, never a stale frame from the last paint.
 * Text overlays are drawn here too, for the same reason: one path, or the
 * preview and the export can disagree.
 */
export function renderFrame(
  context: RenderContext,
  project: Project,
  timelineMicros: number,
  frame: CanvasImageSource | null,
): void {
  const { width, height } = project.composition

  context.save()
  context.fillStyle = '#000000'
  context.fillRect(0, 0, width, height)
  context.restore()

  const found = clipAt(project, timelineMicros)
  const source = found ? project.sources[found.clip.sourceId] : undefined

  if (found && frame && source) {
    drawFrame(
      context,
      frame,
      fitRect(source.width, source.height, width, height),
      source.rotation,
    )
  }

  // Overlays sit on top of whatever the picture turned out to be - including
  // black, so an overlay over a gap still shows. Same call in the preview and
  // in the export, because there is only the one render function.
  for (const overlay of overlaysAt(project, timelineMicros)) {
    drawOverlay(context, overlay)
  }
}

/** Draws one text overlay at its place in the composition. */
export function drawOverlay(context: RenderContext, overlay: Overlay): void {
  if (overlay.content.length === 0 || overlay.sizePx <= 0) return

  context.save()
  context.font = `${overlay.sizePx}px ${OVERLAY_FONT_FAMILY}`
  context.fillStyle = overlay.color
  context.textBaseline = 'top'
  context.fillText(overlay.content, overlay.x, overlay.y)
  context.restore()
}

/**
 * Draws one frame into `rect`, applying the source's rotation.
 *
 * A VideoFrame from mediabunny carries no rotation metadata (its display
 * dimensions are pre-rotation), so the rotation is applied here. Private to
 * renderFrame in spirit; exported only so it can be tested directly.
 */
export function drawFrame(
  context: RenderContext,
  frame: CanvasImageSource,
  rect: FitRect,
  rotation: Rotation,
): void {
  const { x, y, width, height } = rect
  if (width <= 0 || height <= 0) return

  context.save()
  context.translate(x, y)

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

/** Fraction of the export that is complete, as a value from 0 to 1. */
export function exportProgress(
  timelineMicros: number,
  durationMicros: number,
): number {
  if (durationMicros <= 0) return 0
  return Math.min(1, Math.max(0, timelineMicros / durationMicros))
}

/** Turns a source file name into the name the exported MP4 downloads as. */
export function exportFileName(sourceName: string): string {
  const base = sourceName.replace(/\.[^.]*$/, '').trim()
  return base.length > 0 ? `${base}-export.mp4` : 'export.mp4'
}
