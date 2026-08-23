import { textSegmentsAt, visibleVideoSegmentsAt } from './timeline/operations'
import {
  OVERLAY_FONT_FAMILY,
  filterFor,
  transformAt,
  type Project,
  type Rotation,
  type Segment,
  type TextContent,
  type Transform,
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

/**
 * The decoded picture for each video segment that has to be drawn, by segment
 * id. A segment present with a null frame is one whose decode produced nothing
 * yet; an absent one is not being drawn at all.
 *
 * Keyed by segment rather than by track because that is what the renderer is
 * actually asking for - "the frame for this segment" - and it keeps a row that
 * changes segment mid-buffer from being handed the wrong picture.
 */
export type DecodedLayers = ReadonlyMap<string, CanvasImageSource | null>

/** No layers at all: a gap, or a still-empty buffer. */
export const NO_LAYERS: DecodedLayers = new Map()

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
 * Text is drawn here too, for the same reason: one path, or the preview and
 * the export can disagree.
 *
 * Rows are painted bottom of the stack upwards, video first and then text, so
 * a row higher in the stack lands over one below it. Each is drawn through its
 * own transform, resolved from the keyframes at this exact moment - so an
 * animation is a property of the render, not something played back separately.
 */
export function renderFrame(
  context: RenderContext,
  project: Project,
  timelineMicros: number,
  layers: DecodedLayers,
): void {
  const { width, height } = project.composition

  context.save()
  context.fillStyle = '#000000'
  context.fillRect(0, 0, width, height)
  context.restore()

  for (const { segment } of visibleVideoSegmentsAt(project, timelineMicros)) {
    const frame = layers.get(segment.id)
    if (!frame) continue

    const content = segment.content
    if (content.kind !== 'video') continue

    const source = project.sources[content.sourceId]
    if (!source) continue

    const rect = fitRect(source.width, source.height, width, height)
    withTransform(
      context,
      transformAt(segment, timelineMicros),
      { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      () => {
        context.filter = filterFor(
          segment.effects,
          timelineMicros - segment.timelineStartMicros,
        )
        drawFrame(context, frame, rect, source.rotation)
      },
    )
  }

  // Text sits on top of whatever the picture turned out to be - including
  // black, so a caption over a gap still shows. Same call in the preview and
  // in the export, because there is only the one render function.
  for (const { segment, content: text } of textSegmentsAt(
    project,
    timelineMicros,
  )) {
    // Text scales about its own anchor rather than about a centre: it has no
    // box of its own until it is measured, and holding the corner still is
    // what makes a size change predictable to drag against.
    withTransform(
      context,
      transformAt(segment, timelineMicros),
      { x: text.x, y: text.y },
      () => {
        context.filter = filterFor(
          segment.effects,
          timelineMicros - segment.timelineStartMicros,
        )
        drawText(context, text)
      },
    )
  }
}

/**
 * Runs `draw` with a segment transform applied around `origin`.
 *
 * An identity transform leaves the context exactly as it found it, so an
 * untransformed segment renders byte for byte as it did before transforms
 * existed. That is what keeps the golden-frame comparison honest.
 */
export function withTransform(
  context: RenderContext,
  transform: Transform,
  origin: { x: number; y: number },
  draw: () => void,
): void {
  if (transform.opacity <= 0) return

  context.save()
  try {
    context.globalAlpha = Math.min(1, transform.opacity)
    context.translate(transform.x, transform.y)

    if (transform.scale !== 1) {
      context.translate(origin.x, origin.y)
      context.scale(transform.scale, transform.scale)
      context.translate(-origin.x, -origin.y)
    }

    draw()
  } finally {
    context.restore()
  }
}

/** Which segments the decoder has to produce a picture for at this moment. */
export function layerSegmentsAt(
  project: Project,
  timelineMicros: number,
): Segment[] {
  return visibleVideoSegmentsAt(project, timelineMicros).map(
    (entry) => entry.segment,
  )
}

/** Draws one line of text at its place in the composition. */
export function drawText(context: RenderContext, text: TextContent): void {
  if (text.content.length === 0 || text.sizePx <= 0) return

  context.save()
  context.font = `${text.sizePx}px ${OVERLAY_FONT_FAMILY}`
  context.fillStyle = text.color
  context.textBaseline = 'top'
  context.fillText(text.content, text.x, text.y)
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
