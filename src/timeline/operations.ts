import { produce } from 'immer'
import {
  ANIMATABLE_PROPERTIES,
  EFFECT_KINDS,
  EXPORT_QUALITIES,
  exportSettingsOf,
  MIN_SEGMENT_MICROS,
  BLEND_MODES,
  DEFAULT_CHROMA_KEY,
  FONT_FAMILIES,
  MASK_SHAPES,
  TEXT_ALIGNMENTS,
  TRANSITION_KINDS,
  clampEffectAmount,
  clampProperty,
  clampRate,
  sourceMicrosAt,
  sourceSpanFor,
  timelineSpanFor,
  transitionProgress,
  findSegment,
  occludesEverything,
  segmentCovers,
  segmentDuration,
  segmentEndMicros,
  segmentRate,
  soundContent,
  trackAllowsOverlap,
  type Composition,
  type Project,
  type Segment,
  type SegmentContent,
  type Source,
  type TextContent,
  type AnimatableProperty,
  type Effect,
  type EffectKind,
  type BlendMode,
  type ChromaKey,
  type ExportSettings,
  type Keyframes,
  type Mask,
  type MaskShape,
  type TextAlign,
  type SoundContent,
  type TransitionKind,
  type Track,
  type TrackKind,
} from './types'

/**
 * Every operation exists twice: a `mutators.*` recipe that edits an immer
 * draft, and a pure `(project, args) => Project` wrapper below it.
 *
 * The wrappers are the public API and what the tests exercise. The store uses
 * the recipes directly with produceWithPatches, because a recipe that mutates
 * yields fine-grained undo patches while one that returns a new object only
 * yields a single whole-state replace.
 *
 * There is one move and one trim, not one per kind of thing. A caption and a
 * clip differ in what they draw and in whether their row lets them overlap,
 * and both of those are properties of the track, so the operations read them
 * from there rather than being written out twice.
 */

function assertIntegerMicros(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer number of microseconds.`)
  }
}

function requireSource(project: Project, sourceId: string): Source {
  const source = project.sources[sourceId]
  if (!source) {
    throw new Error(`No source with id ${sourceId}.`)
  }
  return source
}

function requireTrack(project: Project, trackId: string): Track {
  const track = project.tracks.find((candidate) => candidate.id === trackId)
  if (!track) {
    throw new Error(`No track with id ${trackId}.`)
  }
  return track
}

function requireSegment(
  project: Project,
  segmentId: string,
): { track: Track; segment: Segment; index: number } {
  const found = findSegment(project, segmentId)
  if (!found) {
    throw new Error(`No segment with id ${segmentId}.`)
  }
  return found
}

function requireEffect(
  project: Project,
  segmentId: string,
  effectId: string,
): Effect {
  const { segment } = requireSegment(project, segmentId)
  const effect = segment.effects?.find(
    (candidate) => candidate.id === effectId,
  )
  if (!effect) {
    throw new Error(`No effect with id ${effectId} on segment ${segmentId}.`)
  }
  return effect
}

function sortSegments(track: Track): void {
  track.segments.sort((a, b) => a.timelineStartMicros - b.timelineStartMicros)
}

/**
 * How much two segments are allowed to sit on top of one another.
 *
 * Zero, except where a transition explains it: a dissolve needs both sides on
 * screen at once, so the incoming segment is allowed to reach back into the
 * outgoing one by exactly the transition's length and not a microsecond more.
 */
function allowedOverlapMicros(earlier: Segment, later: Segment): number {
  if (later.timelineStartMicros < earlier.timelineStartMicros) return 0
  return later.transitionIn?.durationMicros ?? 0
}

/** Throws if `candidate` would overlap anything else on a track that forbids it. */
function assertNoOverlap(track: Track, candidate: Segment): void {
  if (trackAllowsOverlap(track.kind)) return

  const start = candidate.timelineStartMicros
  const end = segmentEndMicros(candidate)

  for (const segment of track.segments) {
    if (segment.id === candidate.id) continue

    const overlapStart = Math.max(start, segment.timelineStartMicros)
    const overlapEnd = Math.min(end, segmentEndMicros(segment))
    const overlap = overlapEnd - overlapStart
    if (overlap <= 0) continue

    const [earlier, later] =
      segment.timelineStartMicros <= start
        ? [segment, candidate]
        : [candidate, segment]

    if (overlap > allowedOverlapMicros(earlier, later)) {
      throw new Error(
        `A segment at ${start}us would overlap segment ${segment.id}.`,
      )
    }
  }
}

/**
 * The kind of track a piece of content belongs on.
 *
 * One for one: a video segment goes on a video row, audio on an audio row,
 * text on a text row. Nothing is allowed to be placed anywhere else.
 */
function trackKindFor(content: SegmentContent): TrackKind {
  return content.kind
}

function assertSegmentIdFree(project: Project, segmentId: string): void {
  if (findSegment(project, segmentId)) {
    throw new Error(`A segment with id ${segmentId} already exists.`)
  }
}

/** Checks the parts of a segment that every kind has in common. */
function assertPlaceable(project: Project, segment: Segment): void {
  assertIntegerMicros(segment.timelineStartMicros, 'timelineStartMicros')

  if (segment.timelineStartMicros < 0) {
    throw new Error(
      'A segment cannot start before the beginning of the timeline.',
    )
  }

  const content = segment.content

  if (content.kind === 'text') {
    assertIntegerMicros(content.durationMicros, 'durationMicros')
    if (content.sizePx <= 0) {
      throw new Error('A text segment must have a positive size.')
    }
  } else {
    // Video and audio are the same idea - a window onto a source - so they are
    // checked the same way.
    assertIntegerMicros(content.sourceInMicros, 'sourceInMicros')
    assertIntegerMicros(content.sourceOutMicros, 'sourceOutMicros')

    const source = requireSource(project, content.sourceId)
    if (
      content.sourceInMicros < 0 ||
      content.sourceOutMicros > source.durationMicros
    ) {
      throw new Error(
        `Segment range ${content.sourceInMicros}..${content.sourceOutMicros}us` +
          ` falls outside source ${source.id} (0..${source.durationMicros}us).`,
      )
    }
  }

  if (segmentDuration(segment) < MIN_SEGMENT_MICROS) {
    throw new Error('A segment must have a positive duration.')
  }
}

export type AddTrackInput = {
  id: string
  kind: TrackKind
  /** Where in the stack, bottom first. Appended to the top when omitted. */
  index?: number
}

export type AddSegmentInput = {
  trackId: string
  segment: Segment
}

export type MoveSegmentInput = {
  segmentId: string
  timelineStartMicros: number
  /** Moves the segment to another row as well. Must accept its kind. */
  trackId?: string
}

export type TrimInput = {
  segmentId: string
  /** Where the trimmed edge should land on the timeline. */
  timelineMicros: number
}

export type KeepSourceSpansInput = {
  segmentId: string
  /**
   * The parts of the source to keep, in order and not overlapping. Every one
   * must lie inside the segment's current range.
   */
  spans: { startMicros: number; endMicros: number }[]
  /**
   * Ids for the pieces after the first, which keeps the original's id. Passed
   * in so the operation stays deterministic.
   */
  newSegmentIds: string[]
}

export type DuplicateSegmentInput = {
  segmentId: string
  /** Id for the copy. Passed in so the operation stays deterministic. */
  newSegmentId: string
}

export type SplitSegmentInput = {
  timelineMicros: number
  /** Id for the second half. Passed in so the operation stays deterministic. */
  newSegmentId: string
  /** Restricts the cut to one row. The topmost row with something is cut when omitted. */
  trackId?: string
}

/** A fixed property change. Absent fields are left as they were. */
export type SegmentPropertiesInput = {
  segmentId: string
} & Partial<Record<AnimatableProperty, number>>

export type KeyframeInput = {
  segmentId: string
  property: AnimatableProperty
  /** From the segment head, so the animation travels with the segment. */
  offsetMicros: number
  value: number
}

export type AddEffectInput = {
  segmentId: string
  id: string
  kind: EffectKind
  /** Defaults to the kind's neutral amount, so adding one changes nothing. */
  amount?: number
  /** Where in the chain. Appended when omitted. */
  index?: number
}

export type EffectAmountInput = {
  segmentId: string
  effectId: string
  amount: number
}

export type MaskInput = {
  segmentId: string
  shape?: MaskShape
  x?: number
  y?: number
  width?: number
  height?: number
  featherPx?: number
  inverted?: boolean
}

export type ChromaKeyInput = {
  segmentId: string
  color?: string
  similarity?: number
  smoothness?: number
  spill?: number
}

export type TransitionInput = {
  /** The INCOMING segment: the one being blended into. */
  segmentId: string
  kind: TransitionKind
  durationMicros: number
}

export type EffectKeyframeInput = {
  segmentId: string
  effectId: string
  offsetMicros: number
  value: number
}

/** The editable look of a text segment: everything except when it plays. */
export type TextStyleInput = {
  segmentId: string
  content?: string
  x?: number
  y?: number
  sizePx?: number
  color?: string
  fontFamily?: string
  bold?: boolean
  italic?: boolean
  align?: TextAlign
  outlineWidthPx?: number
  outlineColor?: string
  shadowBlurPx?: number
  shadowColor?: string
  backgroundColor?: string
  backgroundPaddingPx?: number
}

export const mutators = {
  setComposition(project: Project, composition: Composition): void {
    assertIntegerMicros(composition.width, 'composition width')
    assertIntegerMicros(composition.height, 'composition height')

    if (composition.width <= 0 || composition.height <= 0) {
      throw new Error('A composition must have a positive width and height.')
    }

    project.composition = { ...composition }
  },

  /**
   * Changes what the exported file will be. Only the fields given move, so
   * picking a resolution does not reset the quality.
   */
  setExportSettings(project: Project, args: Partial<ExportSettings>): void {
    const next: ExportSettings = { ...exportSettingsOf(project) }

    if (args.heightPx !== undefined) {
      if (args.heightPx !== null) {
        if (!Number.isInteger(args.heightPx) || args.heightPx <= 0) {
          throw new Error(
            'An export height must be a positive whole number of pixels.',
          )
        }
      }
      next.heightPx = args.heightPx
    }

    if (args.quality !== undefined) {
      if (!EXPORT_QUALITIES.includes(args.quality)) {
        throw new Error(`Unknown export quality ${args.quality}.`)
      }
      next.quality = args.quality
    }

    project.exportSettings = next
  },

  addSource(project: Project, source: Source): void {
    assertIntegerMicros(source.durationMicros, 'durationMicros')
    if (source.durationMicros <= 0) {
      throw new Error('A source must have a positive duration.')
    }
    project.sources[source.id] = { ...source }
  },

  /**
   * Forgets a file, and everything that was playing it.
   *
   * The segments have to go with it: one pointing at a source the project no
   * longer knows would draw nothing and could not be explained to anyone
   * looking at it. They leave gaps rather than closing up, exactly as deleting
   * one by hand does - closing up would move footage the user never asked to
   * move.
   *
   * This is why removal is a single operation rather than "delete the clips,
   * then drop the source": as one step it is one thing to undo, and there is no
   * moment in between where the project references a source that is gone.
   */
  removeSource(project: Project, sourceId: string): void {
    if (!project.sources[sourceId]) {
      throw new Error(`No source with id ${sourceId}.`)
    }

    for (const track of project.tracks) {
      track.segments = track.segments.filter((segment) => {
        const content = segment.content
        return content.kind === 'text' || content.sourceId !== sourceId
      })
    }

    delete project.sources[sourceId]
  },

  addTrack(project: Project, input: AddTrackInput): void {
    if (project.tracks.some((track) => track.id === input.id)) {
      throw new Error(`A track with id ${input.id} already exists.`)
    }

    const track: Track = { id: input.id, kind: input.kind, segments: [] }
    const index = input.index ?? project.tracks.length
    project.tracks.splice(
      Math.min(Math.max(index, 0), project.tracks.length),
      0,
      track,
    )
  },

  /** Removes a row and everything on it. */
  removeTrack(project: Project, trackId: string): void {
    const index = project.tracks.findIndex((track) => track.id === trackId)
    if (index < 0) {
      throw new Error(`No track with id ${trackId}.`)
    }
    project.tracks.splice(index, 1)
  },

  /** Reorders a row within the stack, bottom first. */
  moveTrack(project: Project, args: { trackId: string; index: number }): void {
    const from = project.tracks.findIndex((track) => track.id === args.trackId)
    if (from < 0) {
      throw new Error(`No track with id ${args.trackId}.`)
    }

    const [track] = project.tracks.splice(from, 1)
    project.tracks.splice(
      Math.min(Math.max(args.index, 0), project.tracks.length),
      0,
      track!,
    )
  },

  addSegment(project: Project, input: AddSegmentInput): void {
    const track = requireTrack(project, input.trackId)
    const segment: Segment = {
      ...input.segment,
      content: { ...input.segment.content },
    }

    if (track.kind !== trackKindFor(segment.content)) {
      throw new Error(
        `A ${segment.content.kind} segment cannot go on a ${track.kind} track.`,
      )
    }

    assertSegmentIdFree(project, segment.id)
    assertPlaceable(project, segment)
    assertNoOverlap(track, segment)

    track.segments.push(segment)
    sortSegments(track)
  },

  removeSegment(project: Project, segmentId: string): void {
    const { track, index } = requireSegment(project, segmentId)
    track.segments.splice(index, 1)
  },

  /**
   * Moves a segment whole, keeping what it shows.
   *
   * On a row that packs its segments this throws rather than clamping, so an
   * illegal drop is refused; on a row that allows overlap the only bound is
   * the start of the timeline.
   */
  moveSegment(project: Project, args: MoveSegmentInput): void {
    assertIntegerMicros(args.timelineStartMicros, 'timelineStartMicros')

    const { track, segment, index } = requireSegment(project, args.segmentId)
    const target =
      args.trackId === undefined || args.trackId === track.id
        ? track
        : requireTrack(project, args.trackId)

    if (target.kind !== trackKindFor(segment.content)) {
      throw new Error(
        `A ${segment.content.kind} segment cannot go on a ${target.kind} track.`,
      )
    }

    const start = trackAllowsOverlap(target.kind)
      ? Math.max(0, args.timelineStartMicros)
      : args.timelineStartMicros

    if (start < 0) {
      throw new Error(
        'A segment cannot start before the beginning of the timeline.',
      )
    }

    assertNoOverlap(target, { ...segment, timelineStartMicros: start })

    if (target !== track) {
      track.segments.splice(index, 1)
      segment.timelineStartMicros = start
      target.segments.push(segment)
      sortSegments(target)
      return
    }

    segment.timelineStartMicros = start
    sortSegments(track)
  },

  /**
   * Drags the head of a segment, holding the tail still.
   *
   * For video the timeline start and the source in-point move together, so the
   * frames under the segment stay put; for text there is no source to run out
   * of, only the stored duration to shorten.
   */
  trimSegmentStart(project: Project, args: TrimInput): void {
    assertIntegerMicros(args.timelineMicros, 'timelineMicros')

    const { track, segment, index } = requireSegment(project, args.segmentId)
    const packed = !trackAllowsOverlap(track.kind)
    const previous = packed ? track.segments[index - 1] : undefined
    const earliestStart = previous ? segmentEndMicros(previous) : 0
    const content = segment.content

    if (content.kind !== 'text') {
      const requested = args.timelineMicros - segment.timelineStartMicros

      // The head may only reach back as far as there is source to reach into,
      // which at double speed is half as far in timeline terms.
      const minDelta = Math.max(
        -timelineSpanFor(segment, content.sourceInMicros),
        earliestStart - segment.timelineStartMicros,
      )
      const maxDelta = segmentDuration(segment) - MIN_SEGMENT_MICROS
      const delta = Math.min(Math.max(requested, minDelta), maxDelta)

      content.sourceInMicros += sourceSpanFor(segment, delta)
      segment.timelineStartMicros += delta
      return
    }

    const end = segmentEndMicros(segment)
    const start = Math.min(
      Math.max(earliestStart, args.timelineMicros),
      end - MIN_SEGMENT_MICROS,
    )

    segment.timelineStartMicros = start
    content.durationMicros = end - start
    sortSegments(track)
  },

  /** Drags the tail of a segment, holding the head still. */
  trimSegmentEnd(project: Project, args: TrimInput): void {
    assertIntegerMicros(args.timelineMicros, 'timelineMicros')

    const { track, segment, index } = requireSegment(project, args.segmentId)
    const packed = !trackAllowsOverlap(track.kind)
    const next = packed ? track.segments[index + 1] : undefined
    const latestEnd = next ? next.timelineStartMicros : Number.MAX_SAFE_INTEGER
    const content = segment.content

    const requestedDuration =
      Math.min(args.timelineMicros, latestEnd) - segment.timelineStartMicros

    if (content.kind !== 'text') {
      const source = requireSource(project, content.sourceId)
      const maxDuration = timelineSpanFor(
        segment,
        source.durationMicros - content.sourceInMicros,
      )
      const duration = Math.min(
        Math.max(requestedDuration, MIN_SEGMENT_MICROS),
        maxDuration,
      )

      content.sourceOutMicros =
        content.sourceInMicros + sourceSpanFor(segment, duration)
      return
    }

    content.durationMicros = Math.max(requestedDuration, MIN_SEGMENT_MICROS)
  },

  setTextStyle(project: Project, args: TextStyleInput): void {
    const { segment } = requireSegment(project, args.segmentId)
    const content = segment.content

    if (content.kind !== 'text') {
      throw new Error(`Segment ${args.segmentId} is not a text segment.`)
    }

    if (args.content !== undefined) content.content = args.content
    if (args.color !== undefined) content.color = args.color
    if (args.x !== undefined) content.x = Math.round(args.x)
    if (args.y !== undefined) content.y = Math.round(args.y)
    if (args.sizePx !== undefined) {
      if (args.sizePx <= 0) {
        throw new Error('A text segment must have a positive size.')
      }
      content.sizePx = Math.round(args.sizePx)
    }

    if (args.fontFamily !== undefined) {
      if (!FONT_FAMILIES.includes(args.fontFamily as never)) {
        throw new Error(`Unknown font ${args.fontFamily}.`)
      }
      content.fontFamily = args.fontFamily
    }

    if (args.align !== undefined) {
      if (!TEXT_ALIGNMENTS.includes(args.align)) {
        throw new Error(`Unknown alignment ${args.align}.`)
      }
      content.align = args.align
    }

    if (args.bold !== undefined) content.bold = args.bold
    if (args.italic !== undefined) content.italic = args.italic
    if (args.outlineColor !== undefined) {
      content.outlineColor = args.outlineColor
    }
    if (args.shadowColor !== undefined) content.shadowColor = args.shadowColor

    // A background with no colour is no background, so clearing the colour is
    // how one is taken off.
    if (args.backgroundColor !== undefined) {
      if (args.backgroundColor === '') delete content.backgroundColor
      else content.backgroundColor = args.backgroundColor
    }

    for (const field of [
      'outlineWidthPx',
      'shadowBlurPx',
      'backgroundPaddingPx',
    ] as const) {
      const value = args[field]
      if (value === undefined) continue
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${field} cannot be negative.`)
      }
      content[field] = Math.round(value)
    }
  },

  /**
   * Sets the fixed properties of a segment. Only the fields given change, so
   * nudging x does not reset a scale set earlier.
   */
  setSegmentProperties(project: Project, args: SegmentPropertiesInput): void {
    const { segment } = requireSegment(project, args.segmentId)
    const next: Partial<Record<AnimatableProperty, number>> = {
      ...segment.properties,
    }

    for (const property of ANIMATABLE_PROPERTIES) {
      const value = args[property]
      if (value === undefined) continue
      next[property] = clampProperty(property, value)
    }

    segment.properties = next
  },

  /**
   * Puts a keyframe on a property at an offset from the segment's head.
   *
   * A keyframe already at that exact offset is replaced rather than doubled:
   * pressing the button twice at the same spot means "make it this value",
   * not "stack two of them".
   */
  addKeyframe(project: Project, args: KeyframeInput): void {
    assertIntegerMicros(args.offsetMicros, 'offsetMicros')
    if (args.offsetMicros < 0) {
      throw new Error('A keyframe cannot sit before the head of its segment.')
    }
    if (!Number.isFinite(args.value)) {
      throw new Error('A keyframe needs a finite value.')
    }

    const { segment } = requireSegment(project, args.segmentId)
    const value = clampProperty(args.property, args.value)

    const keyframes: Keyframes = segment.keyframes ?? {}
    const curve = [...(keyframes[args.property] ?? [])]

    const existing = curve.findIndex(
      (keyframe) => keyframe.offsetMicros === args.offsetMicros,
    )
    if (existing >= 0) {
      curve[existing] = { offsetMicros: args.offsetMicros, value }
    } else {
      curve.push({ offsetMicros: args.offsetMicros, value })
      curve.sort((a, b) => a.offsetMicros - b.offsetMicros)
    }

    keyframes[args.property] = curve
    segment.keyframes = keyframes
  },

  removeKeyframe(
    project: Project,
    args: { segmentId: string; property: AnimatableProperty; offsetMicros: number },
  ): void {
    const { segment } = requireSegment(project, args.segmentId)
    const curve = segment.keyframes?.[args.property]
    if (!curve) return

    const remaining = curve.filter(
      (keyframe) => keyframe.offsetMicros !== args.offsetMicros,
    )
    if (remaining.length === curve.length) return

    if (remaining.length === 0) {
      delete segment.keyframes![args.property]
    } else {
      segment.keyframes![args.property] = remaining
    }
  },

  /** Drops the animation on one property, or on all of them. */
  clearKeyframes(
    project: Project,
    args: { segmentId: string; property?: AnimatableProperty },
  ): void {
    const { segment } = requireSegment(project, args.segmentId)
    if (!segment.keyframes) return

    if (args.property) {
      delete segment.keyframes[args.property]
    } else {
      segment.keyframes = {}
    }
  },

  /**
   * Puts an effect on a segment.
   *
   * It starts at its kind's neutral amount unless told otherwise, so adding
   * one never changes the picture by itself - the change is the adjustment
   * that follows.
   */
  addEffect(project: Project, input: AddEffectInput): void {
    const { segment } = requireSegment(project, input.segmentId)
    const spec = EFFECT_KINDS[input.kind]
    if (!spec) {
      throw new Error(`Unknown effect kind ${input.kind}.`)
    }

    const effects = segment.effects ?? []
    if (effects.some((effect) => effect.id === input.id)) {
      throw new Error(`An effect with id ${input.id} already exists.`)
    }

    const effect: Effect = {
      id: input.id,
      kind: input.kind,
      amount: clampEffectAmount(input.kind, input.amount ?? spec.neutral),
    }

    const at = input.index ?? effects.length
    effects.splice(Math.min(Math.max(at, 0), effects.length), 0, effect)
    segment.effects = effects
  },

  removeEffect(
    project: Project,
    args: { segmentId: string; effectId: string },
  ): void {
    const { segment } = requireSegment(project, args.segmentId)
    const effects = segment.effects
    if (!effects) return

    const index = effects.findIndex((effect) => effect.id === args.effectId)
    if (index < 0) return

    effects.splice(index, 1)
  },

  setEffectAmount(project: Project, args: EffectAmountInput): void {
    const effect = requireEffect(project, args.segmentId, args.effectId)
    effect.amount = clampEffectAmount(effect.kind, args.amount)
  },

  /** Reorders the chain, which matters: blur then brighten is not the reverse. */
  moveEffect(
    project: Project,
    args: { segmentId: string; effectId: string; index: number },
  ): void {
    const { segment } = requireSegment(project, args.segmentId)
    const effects = segment.effects ?? []
    const from = effects.findIndex((effect) => effect.id === args.effectId)
    if (from < 0) {
      throw new Error(`No effect with id ${args.effectId}.`)
    }

    const [effect] = effects.splice(from, 1)
    effects.splice(Math.min(Math.max(args.index, 0), effects.length), 0, effect!)
  },

  /** Animates an effect amount, on the same clock as a transform curve. */
  addEffectKeyframe(project: Project, args: EffectKeyframeInput): void {
    assertIntegerMicros(args.offsetMicros, 'offsetMicros')
    if (args.offsetMicros < 0) {
      throw new Error('A keyframe cannot sit before the head of its segment.')
    }

    const effect = requireEffect(project, args.segmentId, args.effectId)
    const value = clampEffectAmount(effect.kind, args.value)
    const curve = [...(effect.keyframes ?? [])]

    const existing = curve.findIndex(
      (keyframe) => keyframe.offsetMicros === args.offsetMicros,
    )
    if (existing >= 0) {
      curve[existing] = { offsetMicros: args.offsetMicros, value }
    } else {
      curve.push({ offsetMicros: args.offsetMicros, value })
      curve.sort((a, b) => a.offsetMicros - b.offsetMicros)
    }

    effect.keyframes = curve
  },

  removeEffectKeyframe(
    project: Project,
    args: { segmentId: string; effectId: string; offsetMicros: number },
  ): void {
    const effect = requireEffect(project, args.segmentId, args.effectId)
    const curve = effect.keyframes
    if (!curve) return

    const remaining = curve.filter(
      (keyframe) => keyframe.offsetMicros !== args.offsetMicros,
    )
    if (remaining.length === curve.length) return

    if (remaining.length === 0) {
      delete effect.keyframes
    } else {
      effect.keyframes = remaining
    }
  },

  /**
   * Blends the segment before this one into it.
   *
   * The cost is time: the incoming segment and everything after it on the row
   * slide earlier by the transition's length, so the two overlap by exactly
   * that much and the project gets that much shorter. That is what a
   * transition IS - without it there is no moment when both are on screen.
   */
  setTransition(project: Project, args: TransitionInput): void {
    assertIntegerMicros(args.durationMicros, 'durationMicros')

    if (!TRANSITION_KINDS.includes(args.kind)) {
      throw new Error(`Unknown transition ${args.kind}.`)
    }
    if (args.durationMicros < MIN_SEGMENT_MICROS) {
      throw new Error('A transition must have a positive duration.')
    }

    const { track, segment, index } = requireSegment(project, args.segmentId)
    if (trackAllowsOverlap(track.kind)) {
      throw new Error(
        `A ${track.kind} row has no cuts to put a transition at.`,
      )
    }

    const previous = track.segments[index - 1]
    if (!previous) {
      throw new Error(
        `Segment ${args.segmentId} has nothing before it to blend from.`,
      )
    }

    const already = segment.transitionIn?.durationMicros ?? 0
    if (segmentEndMicros(previous) - already !== segment.timelineStartMicros) {
      throw new Error(
        `A transition needs the two segments to meet; there is a gap before` +
          ` ${args.segmentId}.`,
      )
    }

    // Neither side may be eaten entirely, and the segment before must have
    // room left over after whatever transition it already carries.
    const roomBefore =
      segmentDuration(previous) -
      (previous.transitionIn?.durationMicros ?? 0)
    const roomAfter = segmentDuration(segment)
    const longest = Math.min(roomBefore, roomAfter)

    if (longest < MIN_SEGMENT_MICROS) {
      throw new Error(
        `There is no room for a transition between ${previous.id} and` +
          ` ${segment.id}.`,
      )
    }

    const duration = Math.min(args.durationMicros, longest)

    // Undo whatever the previous transition had shifted, then shift by the new
    // one, so setting a transition twice is not cumulative.
    const shift = duration - already
    for (let i = index; i < track.segments.length; i++) {
      track.segments[i]!.timelineStartMicros -= shift
    }

    segment.transitionIn = { kind: args.kind, durationMicros: duration }
  },

  /**
   * Changes how fast a segment plays.
   *
   * The head stays put and the tail moves, so everything after it on the row
   * ripples by the difference - a slower clip pushes what follows later rather
   * than running over it. Nothing about the source range changes: the same
   * footage plays, over more or less time.
   */
  setSegmentRate(project: Project, args: { segmentId: string; rate: number }): void {
    const { track, segment, index } = requireSegment(project, args.segmentId)

    if (segment.content.kind === 'text') {
      throw new Error('Text has no source to play faster or slower.')
    }

    const rate = clampRate(args.rate)
    const before = segmentDuration(segment)

    segment.rate = rate
    const after = segmentDuration(segment)

    // Throwing anywhere below discards the draft, so the rate assigned above
    // goes with it and the project is left exactly as it was.
    if (after < MIN_SEGMENT_MICROS) {
      throw new Error(
        `At ${rate}x there would be nothing left of ${segment.id}.`,
      )
    }

    // A transition needs both sides to be at least as long as it is, and this
    // segment is one side of up to two of them.
    const own = segment.transitionIn?.durationMicros ?? 0
    const next = track.segments[index + 1]?.transitionIn?.durationMicros ?? 0

    if (after < Math.max(own, next)) {
      throw new Error(
        `At ${rate}x, ${segment.id} would be shorter than the transition it` +
          ` blends across. Remove the transition first.`,
      )
    }

    if (rate === 1) delete segment.rate

    const shift = after - before
    if (shift !== 0 && !trackAllowsOverlap(track.kind)) {
      for (let i = index + 1; i < track.segments.length; i++) {
        track.segments[i]!.timelineStartMicros += shift
      }
    }
  },

  /** Sets how a segment combines with what is under it. */
  setSegmentBlendMode(
    project: Project,
    args: { segmentId: string; blendMode: BlendMode },
  ): void {
    if (!BLEND_MODES.includes(args.blendMode)) {
      throw new Error(`Unknown blend mode ${args.blendMode}.`)
    }

    const { segment } = requireSegment(project, args.segmentId)
    if (args.blendMode === 'normal') {
      delete segment.blendMode
      return
    }

    segment.blendMode = args.blendMode
  },

  /**
   * Sets the mask on a segment, creating one if there was none.
   *
   * A mask that has just appeared covers the middle half of the composition,
   * so it is somewhere findable rather than nowhere. Only the fields given
   * change after that.
   */
  setSegmentMask(project: Project, args: MaskInput): void {
    const { segment } = requireSegment(project, args.segmentId)

    if (args.shape !== undefined && !MASK_SHAPES.includes(args.shape)) {
      throw new Error(`Unknown mask shape ${args.shape}.`)
    }

    const { width, height } = project.composition
    const existing: Mask = segment.mask ?? {
      shape: args.shape ?? 'rectangle',
      x: Math.round(width / 2),
      y: Math.round(height / 2),
      width: Math.round(width / 2),
      height: Math.round(height / 2),
      featherPx: 0,
      inverted: false,
    }

    const next: Mask = { ...existing }
    if (args.shape !== undefined) next.shape = args.shape
    for (const field of ['x', 'y', 'width', 'height', 'featherPx'] as const) {
      const value = args[field]
      if (value === undefined) continue
      if (!Number.isFinite(value)) {
        throw new Error(`A mask ${field} must be a finite number.`)
      }
      next[field] = Math.round(value)
    }
    if (args.inverted !== undefined) next.inverted = args.inverted

    if (next.width <= 0 || next.height <= 0) {
      throw new Error('A mask must have a positive width and height.')
    }
    if (next.featherPx < 0) {
      throw new Error('A mask cannot have a negative feather.')
    }

    segment.mask = next
  },

  /**
   * Keys a colour out of a segment, starting from a green screen.
   *
   * Only the fields given change, so nudging the tolerance does not reset the
   * colour that was sampled.
   */
  setChromaKey(project: Project, args: ChromaKeyInput): void {
    const { segment } = requireSegment(project, args.segmentId)

    if (segment.content.kind !== 'video') {
      throw new Error('Only a picture has a colour to key out.')
    }

    const next: ChromaKey = { ...(segment.chromaKey ?? DEFAULT_CHROMA_KEY) }

    if (args.color !== undefined) {
      if (!/^#[0-9a-f]{6}$/i.test(args.color)) {
        throw new Error(`${args.color} is not a colour this can key.`)
      }
      next.color = args.color
    }

    for (const field of ['similarity', 'smoothness', 'spill'] as const) {
      const value = args[field]
      if (value === undefined) continue
      if (!Number.isFinite(value)) {
        throw new Error(`A key ${field} must be a finite number.`)
      }
      next[field] = Math.min(1, Math.max(0, value))
    }

    segment.chromaKey = next
  },

  removeChromaKey(project: Project, segmentId: string): void {
    const { segment } = requireSegment(project, segmentId)
    delete segment.chromaKey
  },

  removeSegmentMask(project: Project, segmentId: string): void {
    const { segment } = requireSegment(project, segmentId)
    delete segment.mask
  },

  /** Takes a transition off, giving back the time it was costing. */
  removeTransition(project: Project, segmentId: string): void {
    const { track, segment, index } = requireSegment(project, segmentId)
    const existing = segment.transitionIn
    if (!existing) return

    for (let i = index; i < track.segments.length; i++) {
      track.segments[i]!.timelineStartMicros += existing.durationMicros
    }

    delete segment.transitionIn
  },

  /**
   * Replaces a segment with the parts of it worth keeping.
   *
   * This is what trimming silence does once something has decided WHICH parts
   * those are - and that decision is not made here, because it needs the
   * waveform and the waveform is not part of the project. See `silence.ts`.
   *
   * The pieces are laid end to end from where the original started, so the
   * sound is continuous rather than pockmarked with the gaps that were removed.
   * Everything after them on a packed row moves earlier by however much came
   * out; the row stays packed, exactly as applying a transition keeps it packed
   * by pulling things the other way.
   *
   * Only the first piece keeps a transition into it. The rest begin at a cut
   * this operation just made, and there is nothing behind them to blend from.
   */
  keepSourceSpans(project: Project, input: KeepSourceSpansInput): void {
    const { track, segment, index } = requireSegment(project, input.segmentId)

    const sound = soundContent(segment)
    if (!sound) {
      throw new Error('Text has no source to keep parts of.')
    }

    if (input.spans.length === 0) {
      throw new Error(
        'Keeping nothing would delete the segment; remove it instead.',
      )
    }

    let previousEnd = sound.sourceInMicros
    for (const span of input.spans) {
      assertIntegerMicros(span.startMicros, 'span startMicros')
      assertIntegerMicros(span.endMicros, 'span endMicros')

      if (span.startMicros < previousEnd) {
        throw new Error('Spans have to be in order and must not overlap.')
      }
      if (span.endMicros <= span.startMicros) {
        throw new Error('A span must cover some time.')
      }
      if (span.endMicros > sound.sourceOutMicros) {
        throw new Error(
          `A span reaching ${span.endMicros}us is outside the segment's range.`,
        )
      }
      previousEnd = span.endMicros
    }

    if (input.newSegmentIds.length < input.spans.length - 1) {
      throw new Error(
        `Keeping ${input.spans.length} spans needs ${input.spans.length - 1} new ids.`,
      )
    }
    for (const id of input.newSegmentIds.slice(0, input.spans.length - 1)) {
      assertSegmentIdFree(project, id)
    }

    const rate = segmentRate(segment)
    const before = segmentDuration(segment)

    // Built as a list first: the row has to be left in one consistent state
    // rather than passing through several as pieces are spliced in.
    const pieces: Segment[] = []
    let start = segment.timelineStartMicros

    input.spans.forEach((span, position) => {
      // Timeline state is plain JSON, so a round trip through it is a complete
      // copy - keyframes and effects included, sharing nothing with the others.
      // structuredClone cannot be used here: this runs on an immer draft, and
      // a draft is a Proxy.
      const piece: Segment = {
        ...(JSON.parse(JSON.stringify(segment)) as Segment),
        id: position === 0 ? segment.id : input.newSegmentIds[position - 1]!,
        timelineStartMicros: start,
        content: {
          ...sound,
          sourceInMicros: span.startMicros,
          sourceOutMicros: span.endMicros,
        },
      }

      if (position > 0) delete piece.transitionIn

      pieces.push(piece)
      start += Math.round((span.endMicros - span.startMicros) / rate)
    })

    const after = start - segment.timelineStartMicros
    const removed = before - after

    track.segments.splice(index, 1, ...pieces)

    if (removed > 0 && !trackAllowsOverlap(track.kind)) {
      for (const later of track.segments.slice(index + pieces.length)) {
        later.timelineStartMicros -= removed
      }
    }

    sortSegments(track)
  },

  /**
   * Puts a copy of a segment immediately after it.
   *
   * A packed row has no room for one, so everything after moves along by the
   * copy's length and the project gets that much longer - the mirror of what
   * applying a transition does, which pulls everything earlier. A row that
   * allows overlap needs no such thing.
   */
  duplicateSegment(project: Project, input: DuplicateSegmentInput): void {
    assertSegmentIdFree(project, input.newSegmentId)

    for (const track of project.tracks) {
      const index = track.segments.findIndex(
        (segment) => segment.id === input.segmentId,
      )
      if (index < 0) continue

      const segment = track.segments[index]!
      const length = segmentDuration(segment)

      // Timeline state is plain JSON, so a round trip through it is a complete
      // copy: keyframes, effects and all, sharing nothing with the original.
      const copy = JSON.parse(JSON.stringify(segment)) as Segment
      copy.id = input.newSegmentId
      copy.timelineStartMicros = segmentEndMicros(segment)

      // The copy is placed AT the original's end rather than reaching back
      // into it, so it blends across nothing and carries no transition. One
      // can be applied to it afterwards like any other.
      delete copy.transitionIn

      if (!trackAllowsOverlap(track.kind)) {
        for (const later of track.segments.slice(index + 1)) {
          later.timelineStartMicros += length
        }
      }

      assertNoOverlap(track, copy)
      track.segments.splice(index + 1, 0, copy)
      return
    }

    throw new Error(`No segment with id ${input.segmentId}.`)
  },

  /**
   * Cuts the segment under `timelineMicros` in two.
   *
   * A cut in empty space, or exactly on a boundary, is a no-op: neither half
   * may be empty. Without a trackId the cut lands on the topmost row that has
   * something under the playhead, which is what a cut button means when the
   * selection is somewhere else.
   */
  splitSegmentAt(project: Project, input: SplitSegmentInput): void {
    assertIntegerMicros(input.timelineMicros, 'timelineMicros')

    const tracks =
      input.trackId === undefined
        ? [...project.tracks].reverse()
        : [requireTrack(project, input.trackId)]

    for (const track of tracks) {
      const index = track.segments.findIndex(
        (segment) =>
          segment.timelineStartMicros < input.timelineMicros &&
          input.timelineMicros < segmentEndMicros(segment),
      )
      if (index < 0) continue

      assertSegmentIdFree(project, input.newSegmentId)

      const segment = track.segments[index]!
      const offset = input.timelineMicros - segment.timelineStartMicros
      const content = segment.content

      let secondContent: SegmentContent
      if (content.kind === 'text') {
        secondContent = {
          ...content,
          durationMicros: content.durationMicros - offset,
        }
        content.durationMicros = offset
      } else {
        const cutAtSource = sourceMicrosAt(segment, input.timelineMicros)
        secondContent = {
          ...(content as SoundContent),
          sourceInMicros: cutAtSource,
          sourceOutMicros: content.sourceOutMicros,
        }
        content.sourceOutMicros = cutAtSource
      }

      // Both halves keep the speed the whole was playing at.
      const second: Segment = {
        id: input.newSegmentId,
        timelineStartMicros: input.timelineMicros,
        content: secondContent,
      }
      if (segment.rate !== undefined) second.rate = segment.rate

      track.segments.splice(index + 1, 0, second)
      return
    }
  },
}

export const setComposition = (
  project: Project,
  composition: Composition,
): Project =>
  produce(project, (draft) => mutators.setComposition(draft, composition))

export const addSource = (project: Project, source: Source): Project =>
  produce(project, (draft) => mutators.addSource(draft, source))

export const removeSource = (project: Project, sourceId: string): Project =>
  produce(project, (draft) => mutators.removeSource(draft, sourceId))

export const setExportSettings = (
  project: Project,
  args: Partial<ExportSettings>,
): Project =>
  produce(project, (draft) => mutators.setExportSettings(draft, args))

export const addTrack = (project: Project, input: AddTrackInput): Project =>
  produce(project, (draft) => mutators.addTrack(draft, input))

export const removeTrack = (project: Project, trackId: string): Project =>
  produce(project, (draft) => mutators.removeTrack(draft, trackId))

export const moveTrack = (
  project: Project,
  args: { trackId: string; index: number },
): Project => produce(project, (draft) => mutators.moveTrack(draft, args))

export const addSegment = (project: Project, input: AddSegmentInput): Project =>
  produce(project, (draft) => mutators.addSegment(draft, input))

export const removeSegment = (project: Project, segmentId: string): Project =>
  produce(project, (draft) => mutators.removeSegment(draft, segmentId))

export const moveSegment = (project: Project, args: MoveSegmentInput): Project =>
  produce(project, (draft) => mutators.moveSegment(draft, args))

export const trimSegmentStart = (project: Project, args: TrimInput): Project =>
  produce(project, (draft) => mutators.trimSegmentStart(draft, args))

export const trimSegmentEnd = (project: Project, args: TrimInput): Project =>
  produce(project, (draft) => mutators.trimSegmentEnd(draft, args))

export const setTextStyle = (project: Project, args: TextStyleInput): Project =>
  produce(project, (draft) => mutators.setTextStyle(draft, args))

export const keepSourceSpans = (
  project: Project,
  input: KeepSourceSpansInput,
): Project =>
  produce(project, (draft) => mutators.keepSourceSpans(draft, input))

export const duplicateSegment = (
  project: Project,
  input: DuplicateSegmentInput,
): Project =>
  produce(project, (draft) => mutators.duplicateSegment(draft, input))

export const splitSegmentAt = (
  project: Project,
  input: SplitSegmentInput,
): Project => produce(project, (draft) => mutators.splitSegmentAt(draft, input))

export const setSegmentRate = (
  project: Project,
  args: { segmentId: string; rate: number },
): Project =>
  produce(project, (draft) => mutators.setSegmentRate(draft, args))

export const setSegmentBlendMode = (
  project: Project,
  args: { segmentId: string; blendMode: BlendMode },
): Project =>
  produce(project, (draft) => mutators.setSegmentBlendMode(draft, args))

export const setSegmentMask = (project: Project, args: MaskInput): Project =>
  produce(project, (draft) => mutators.setSegmentMask(draft, args))

export const removeSegmentMask = (
  project: Project,
  segmentId: string,
): Project =>
  produce(project, (draft) => mutators.removeSegmentMask(draft, segmentId))

export const setChromaKey = (
  project: Project,
  args: ChromaKeyInput,
): Project => produce(project, (draft) => mutators.setChromaKey(draft, args))

export const removeChromaKey = (
  project: Project,
  segmentId: string,
): Project =>
  produce(project, (draft) => mutators.removeChromaKey(draft, segmentId))

export const setTransition = (
  project: Project,
  args: TransitionInput,
): Project => produce(project, (draft) => mutators.setTransition(draft, args))

export const removeTransition = (
  project: Project,
  segmentId: string,
): Project =>
  produce(project, (draft) => mutators.removeTransition(draft, segmentId))

export const setSegmentProperties = (
  project: Project,
  args: SegmentPropertiesInput,
): Project =>
  produce(project, (draft) => mutators.setSegmentProperties(draft, args))

export const addKeyframe = (project: Project, args: KeyframeInput): Project =>
  produce(project, (draft) => mutators.addKeyframe(draft, args))

export const removeKeyframe = (
  project: Project,
  args: { segmentId: string; property: AnimatableProperty; offsetMicros: number },
): Project => produce(project, (draft) => mutators.removeKeyframe(draft, args))

export const clearKeyframes = (
  project: Project,
  args: { segmentId: string; property?: AnimatableProperty },
): Project => produce(project, (draft) => mutators.clearKeyframes(draft, args))

export const addEffect = (project: Project, input: AddEffectInput): Project =>
  produce(project, (draft) => mutators.addEffect(draft, input))

export const removeEffect = (
  project: Project,
  args: { segmentId: string; effectId: string },
): Project => produce(project, (draft) => mutators.removeEffect(draft, args))

export const setEffectAmount = (
  project: Project,
  args: EffectAmountInput,
): Project => produce(project, (draft) => mutators.setEffectAmount(draft, args))

export const moveEffect = (
  project: Project,
  args: { segmentId: string; effectId: string; index: number },
): Project => produce(project, (draft) => mutators.moveEffect(draft, args))

export const addEffectKeyframe = (
  project: Project,
  args: EffectKeyframeInput,
): Project =>
  produce(project, (draft) => mutators.addEffectKeyframe(draft, args))

export const removeEffectKeyframe = (
  project: Project,
  args: { segmentId: string; effectId: string; offsetMicros: number },
): Project =>
  produce(project, (draft) => mutators.removeEffectKeyframe(draft, args))

/** The video rows, bottom of the stack first. */
export function videoTracks(project: Project): Track[] {
  return project.tracks.filter((track) => track.kind === 'video')
}

/**
 * The rows that make a sound, bottom of the stack first.
 *
 * Video rows count: a clip carries its own audio, and muting one is the same
 * operation as lowering a piece of music.
 */
export function soundTracks(project: Project): Track[] {
  return project.tracks.filter(
    (track) => track.kind === 'video' || track.kind === 'audio',
  )
}

/** The audio rows, bottom of the stack first. */
export function audioTracks(project: Project): Track[] {
  return project.tracks.filter((track) => track.kind === 'audio')
}

/** The text rows, bottom of the stack first. */
export function textTracks(project: Project): Track[] {
  return project.tracks.filter((track) => track.kind === 'text')
}

/**
 * Which video segment is showing at `timelineMicros`, and where that lands in
 * its source.
 *
 * The topmost row wins. A full-frame picture on an upper row hides whatever is
 * under it, so there is nothing to be gained by decoding the rest.
 */
export function videoSegmentAt(
  project: Project,
  timelineMicros: number,
): { track: Track; segment: Segment; sourceMicros: number } | null {
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i]!
    if (track.kind !== 'video') continue

    const segment = track.segments.find((candidate) =>
      segmentCovers(candidate, timelineMicros),
    )
    if (!segment) continue

    return {
      track,
      segment,
      sourceMicros: sourceMicrosAt(segment, timelineMicros),
    }
  }

  return null
}

/**
 * Every video segment that has to be DRAWN at `timelineMicros`, bottom row
 * first.
 *
 * Not simply everything covering the position: rows below one that fills the
 * composition opaquely are hidden, and decoding them would be work whose
 * result is painted over. The moment an upper segment is scaled, moved or
 * faded it stops hiding anything, and the row beneath comes back into the
 * list - which is the whole point of a transform.
 */
export function visibleVideoSegmentsAt(
  project: Project,
  timelineMicros: number,
): { track: Track; segment: Segment; sourceMicros: number }[] {
  const stack: { track: Track; segment: Segment; sourceMicros: number }[] = []

  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i]!
    if (track.kind !== 'video') continue

    // Usually one, but two while a transition is running: the outgoing
    // segment and the incoming one blending over it. Later in the list means
    // later on the row, which is also the order they are drawn in.
    const covering = track.segments.filter((candidate) =>
      segmentCovers(candidate, timelineMicros),
    )
    if (covering.length === 0) continue

    for (let c = covering.length - 1; c >= 0; c--) {
      const segment = covering[c]!
      stack.push({
        track,
        segment,
        sourceMicros: sourceMicrosAt(segment, timelineMicros),
      })
    }

    // Only the topmost of the row can hide what is under it, and only if it
    // is not itself being blended into.
    const top = covering[covering.length - 1]!
    if (
      transitionProgress(top, timelineMicros) === null &&
      occludesEverything(
        top,
        project.composition,
        project.sources,
        timelineMicros,
      )
    ) {
      break
    }
  }

  return stack.reverse()
}

/**
 * How long the answer from videoSegmentAt stays the same, as an exclusive end.
 *
 * The showing segment changes either when it runs out or when something on a
 * HIGHER row starts and takes over. A decoder walking the timeline has to stop
 * at whichever comes first: walking to the segment's own end would keep
 * handing over frames from a row that is no longer the one being shown, and
 * the export would drift away from the preview.
 *
 * Null when nothing is showing at `timelineMicros`.
 */
export function videoResolutionEndAfter(
  project: Project,
  timelineMicros: number,
): number | null {
  const found = videoSegmentAt(project, timelineMicros)
  if (!found) return null

  let end = segmentEndMicros(found.segment)

  for (let i = project.tracks.indexOf(found.track) + 1; i < project.tracks.length; i++) {
    const track = project.tracks[i]!
    if (track.kind !== 'video') continue

    // Segments are sorted, so the first one starting after the position is the
    // soonest this row could take over.
    for (const segment of track.segments) {
      if (segment.timelineStartMicros <= timelineMicros) continue
      if (segment.timelineStartMicros < end) end = segment.timelineStartMicros
      break
    }
  }

  return end
}

/** Which text segments are showing at `timelineMicros`, in draw order. */
export function textSegmentsAt(
  project: Project,
  timelineMicros: number,
): { segment: Segment; content: TextContent }[] {
  const showing: { segment: Segment; content: TextContent }[] = []

  for (const track of project.tracks) {
    if (track.kind !== 'text') continue
    for (const segment of track.segments) {
      if (!segmentCovers(segment, timelineMicros)) continue
      showing.push({ segment, content: segment.content as TextContent })
    }
  }

  return showing
}

/**
 * Exclusive end of the timeline: the last segment on any row, whichever runs
 * longest. A caption past the final clip still has to be playable.
 */
export function timelineDuration(project: Project): number {
  let end = 0
  for (const track of project.tracks) {
    for (const segment of track.segments) {
      end = Math.max(end, segmentEndMicros(segment))
    }
  }
  return end
}
