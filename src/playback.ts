import { keyFrame } from './gpu'
import { textSegmentsAt, visibleVideoSegmentsAt } from './timeline/operations'
import {
  LINE_HEIGHT,
  fontStringFor,
  textLines,
  type BlendMode,
  type Mask,
  filterFor,
  transformAt,
  transitionAlphas,
  transitionProgress,
  type Project,
  type Rotation,
  type Segment,
  type TextContent,
  type Track,
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

  for (const { track, segment } of visibleVideoSegmentsAt(
    project,
    timelineMicros,
  )) {
    const frame = layers.get(segment.id)
    if (!frame) continue

    const content = segment.content
    if (content.kind !== 'video') continue

    const source = project.sources[content.sourceId]
    if (!source) continue

    const blend = transitionBlendAt(track, segment, timelineMicros)
    if (blend.alpha <= 0) continue

    const rect = fitRect(source.width, source.height, width, height)

    // Per-pixel work happens BEFORE anything else touches the frame: the key
    // decides which pixels exist, and the transform, mask and blend then act
    // on what is left. Falling back to the raw frame means a picture with its
    // background still in it, which beats no picture.
    const drawable = segment.chromaKey
      ? (keyFrame(
          context,
          frame,
          source.width,
          source.height,
          segment.chromaKey,
        ) ?? frame)
      : frame

    drawSegment(context, project, segment, timelineMicros, blend, {
      origin: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      draw: (target) => drawFrame(target, drawable, rect, source.rotation),
    })
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
    drawSegment(
      context,
      project,
      segment,
      timelineMicros,
      { alpha: 1, wipeFraction: null },
      {
        origin: { x: text.x, y: text.y },
        draw: (target) => drawText(target, text),
      },
    )
  }
}

/**
 * Draws one segment's content through everything that governs how it lands:
 * its transform, its effects, its mask, its blend mode, and whatever a
 * transition is doing to it.
 *
 * A segment with none of those takes the direct path and is drawn exactly as
 * it was before any of this existed - which is what keeps the golden-frame
 * comparison, and every existing pixel, meaning what they meant.
 */
function drawSegment(
  context: RenderContext,
  project: Project,
  segment: Segment,
  timelineMicros: number,
  blend: { alpha: number; wipeFraction: number | null },
  content: {
    origin: { x: number; y: number }
    draw: (target: RenderContext) => void
  },
): void {
  const { width, height } = project.composition
  const transform = transformAt(segment, timelineMicros)
  const alpha = Math.min(1, transform.opacity * blend.alpha)
  if (alpha <= 0) return

  const blendMode = segment.blendMode ?? 'normal'
  const filter = filterFor(
    segment.effects,
    timelineMicros - segment.timelineStartMicros,
  )

  // No mask: straight onto the composition, which is the ordinary case and
  // the cheap one.
  if (!segment.mask) {
    withTransform(context, { ...transform, opacity: alpha }, content.origin, () => {
      if (blend.wipeFraction !== null) clipWipe(context, width, height, blend.wipeFraction)
      context.globalCompositeOperation = compositeOperationFor(blendMode)
      context.filter = filter
      content.draw(context)
    })
    return
  }

  // Masked: the segment is drawn on its own first, so the mask can cut it
  // without touching anything already on the composition. Cutting in place
  // would take the rows underneath with it.
  const scratch = scratchLayer(context, width, height)
  if (!scratch) {
    // No offscreen canvas to be had. Better an unmasked picture than none.
    withTransform(context, { ...transform, opacity: alpha }, content.origin, () => {
      if (blend.wipeFraction !== null) clipWipe(context, width, height, blend.wipeFraction)
      context.globalCompositeOperation = compositeOperationFor(blendMode)
      context.filter = filter
      content.draw(context)
    })
    return
  }

  scratch.clearRect(0, 0, width, height)
  withTransform(
    scratch,
    { ...transform, opacity: 1 },
    content.origin,
    () => {
      scratch.filter = filter
      content.draw(scratch)
    },
  )
  applyMask(scratch, segment.mask)

  context.save()
  try {
    if (blend.wipeFraction !== null) clipWipe(context, width, height, blend.wipeFraction)
    context.globalAlpha = alpha
    context.globalCompositeOperation = compositeOperationFor(blendMode)
    context.drawImage(scratch.canvas as CanvasImageSource, 0, 0)
  } finally {
    context.restore()
  }
}

/** The canvas name for a blend mode. */
export function compositeOperationFor(mode: BlendMode): GlobalCompositeOperation {
  return mode === 'normal' ? 'source-over' : (mode as GlobalCompositeOperation)
}

/** Limits drawing to the part of the frame a wipe has revealed. */
function clipWipe(
  context: RenderContext,
  width: number,
  height: number,
  fraction: number,
): void {
  context.beginPath()
  context.rect(0, 0, width * fraction, height)
  context.clip()
}

/**
 * Cuts everything outside a mask out of a layer that has already been drawn.
 *
 * `destination-in` keeps what the shape covers and throws the rest away, and
 * a blur on the shape is what softens the edge - so the feather costs one
 * filter rather than a gradient per side.
 */
export function applyMask(context: RenderContext, mask: Mask): void {
  context.save()
  try {
    context.globalCompositeOperation = mask.inverted
      ? 'destination-out'
      : 'destination-in'
    context.filter =
      mask.featherPx > 0 ? `blur(${Math.round(mask.featherPx)}px)` : 'none'
    context.fillStyle = '#ffffff'

    context.beginPath()
    if (mask.shape === 'ellipse') {
      context.ellipse(
        mask.x,
        mask.y,
        Math.max(0, mask.width / 2),
        Math.max(0, mask.height / 2),
        0,
        0,
        Math.PI * 2,
      )
    } else {
      context.rect(
        mask.x - mask.width / 2,
        mask.y - mask.height / 2,
        Math.max(0, mask.width),
        Math.max(0, mask.height),
      )
    }
    context.fill()
  } finally {
    context.restore()
  }
}

/**
 * A composition-sized scratch layer for the given context, made once and
 * reused.
 *
 * Kept in a WeakMap rather than passed in, so renderFrame keeps the signature
 * it had: the buffer is an implementation detail of drawing, not part of what
 * a frame IS. It goes when the context does.
 */
const scratchLayers = new WeakMap<
  RenderContext,
  { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D }
>()

function scratchLayer(
  context: RenderContext,
  width: number,
  height: number,
): OffscreenCanvasRenderingContext2D | null {
  const existing = scratchLayers.get(context)
  if (
    existing &&
    existing.canvas.width === width &&
    existing.canvas.height === height
  ) {
    return existing.context
  }

  if (typeof OffscreenCanvas === 'undefined') return null

  const canvas = new OffscreenCanvas(width, height)
  const scratch = canvas.getContext('2d')
  if (!scratch) return null

  scratchLayers.set(context, { canvas, context: scratch })
  return scratch
}

/**
 * How a segment is blended at this moment, given the transitions around it.
 *
 * A segment is the INCOMING side of its own `transitionIn`, and the OUTGOING
 * side of the one on the segment after it. Away from either it is drawn
 * solid, which is every frame in a project with no transitions at all - so
 * this cannot change what an untransitioned timeline looks like.
 */
export function transitionBlendAt(
  track: Track,
  segment: Segment,
  timelineMicros: number,
): { alpha: number; wipeFraction: number | null } {
  const incoming = transitionProgress(segment, timelineMicros)
  if (incoming !== null) {
    const kind = segment.transitionIn!.kind
    return {
      alpha: transitionAlphas(kind, incoming).incoming,
      wipeFraction: kind === 'wipe' ? incoming : null,
    }
  }

  const index = track.segments.indexOf(segment)
  const next = index >= 0 ? track.segments[index + 1] : undefined
  if (next) {
    const outgoing = transitionProgress(next, timelineMicros)
    if (outgoing !== null) {
      return {
        alpha: transitionAlphas(next.transitionIn!.kind, outgoing).outgoing,
        wipeFraction: null,
      }
    }
  }

  return { alpha: 1, wipeFraction: null }
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

  const lines = textLines(text)
  const lineHeight = text.sizePx * LINE_HEIGHT
  const align = text.align ?? 'left'

  context.save()
  try {
    context.font = fontStringFor(text)
    context.textBaseline = 'top'
    context.textAlign = align

    // The box goes down first, so everything else lands on top of it.
    if (text.backgroundColor) {
      const padding = text.backgroundPaddingPx ?? 0
      const widest = lines.reduce(
        (widest, line) => Math.max(widest, context.measureText(line).width),
        0,
      )
      const boxWidth = widest + padding * 2
      const boxHeight = lines.length * lineHeight + padding * 2
      const left =
        align === 'center'
          ? text.x - boxWidth / 2
          : align === 'right'
            ? text.x - boxWidth
            : text.x - padding

      context.save()
      context.fillStyle = text.backgroundColor
      context.fillRect(left, text.y - padding, boxWidth, boxHeight)
      context.restore()
    }

    const outlineWidth = text.outlineWidthPx ?? 0
    const hasOutline = outlineWidth > 0 && text.outlineColor !== undefined
    const shadowBlur = text.shadowBlurPx ?? 0
    const hasShadow = shadowBlur > 0 && text.shadowColor !== undefined

    /** The outline, doubled and centred so the fill covers its inner half. */
    function stroke(line: string, y: number) {
      context.lineWidth = outlineWidth * 2
      context.lineJoin = 'round'
      context.strokeStyle = text.outlineColor!
      context.strokeText(line, text.x, y)
    }

    function fill(line: string, y: number) {
      context.fillStyle = text.color
      context.fillText(line, text.x, y)
    }

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!
      if (line.length === 0) continue

      const y = text.y + index * lineHeight

      // The shadow is cast ONCE, by whichever mark is outermost - the outline
      // if there is one, the fill if not. Attaching it to both would draw it
      // twice and thicken the edge.
      if (hasShadow) {
        context.save()
        context.shadowBlur = shadowBlur
        context.shadowColor = text.shadowColor!
        if (hasOutline) stroke(line, y)
        else fill(line, y)
        context.restore()
      }

      if (hasOutline && !hasShadow) stroke(line, y)
      if (hasOutline || !hasShadow) fill(line, y)
    }
  } finally {
    context.restore()
  }
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
