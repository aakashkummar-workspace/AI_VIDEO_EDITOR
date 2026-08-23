import { produce } from 'immer'
import {
  ANIMATABLE_PROPERTIES,
  EFFECT_KINDS,
  EXPORT_QUALITIES,
  exportSettingsOf,
  MIN_SEGMENT_MICROS,
  clampEffectAmount,
  findSegment,
  occludesEverything,
  segmentCovers,
  segmentDuration,
  segmentEndMicros,
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
  type ExportSettings,
  type Keyframes,
  type Track,
  type TrackKind,
  type Transform,
  type VideoContent,
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

/** Throws if `candidate` would overlap anything else on a track that forbids it. */
function assertNoOverlap(track: Track, candidate: Segment): void {
  if (trackAllowsOverlap(track.kind)) return

  const start = candidate.timelineStartMicros
  const end = segmentEndMicros(candidate)

  for (const segment of track.segments) {
    if (segment.id === candidate.id) continue
    if (start < segmentEndMicros(segment) && segment.timelineStartMicros < end) {
      throw new Error(
        `A segment at ${start}us would overlap segment ${segment.id}.`,
      )
    }
  }
}

/** The kind of track a piece of content belongs on. */
function trackKindFor(content: SegmentContent): TrackKind {
  return content.kind === 'video' ? 'video' : 'text'
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

  if (content.kind === 'video') {
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
  } else {
    assertIntegerMicros(content.durationMicros, 'durationMicros')
    if (content.sizePx <= 0) {
      throw new Error('A text segment must have a positive size.')
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

export type SplitSegmentInput = {
  timelineMicros: number
  /** Id for the second half. Passed in so the operation stays deterministic. */
  newSegmentId: string
  /** Restricts the cut to one row. The topmost row with something is cut when omitted. */
  trackId?: string
}

/** A fixed transform change. Absent fields are left as they were. */
export type SegmentTransformInput = {
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

export type EffectKeyframeInput = {
  segmentId: string
  effectId: string
  offsetMicros: number
  value: number
}

/**
 * Keeps a transform value inside what it can mean.
 *
 * Opacity outside 0..1 and a scale of zero or less have no rendering, so they
 * are clamped at the edit rather than guarded against at every read.
 */
function clampTransformValue(
  property: AnimatableProperty,
  value: number,
): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${property} must be a finite number.`)
  }
  if (property === 'opacity') return Math.min(1, Math.max(0, value))
  if (property === 'scale') return Math.max(0.01, value)
  return value
}

/** The editable look of a text segment: everything except when it plays. */
export type TextStyleInput = {
  segmentId: string
  content?: string
  x?: number
  y?: number
  sizePx?: number
  color?: string
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

    if (content.kind === 'video') {
      const requested = args.timelineMicros - segment.timelineStartMicros
      const minDelta = Math.max(
        -content.sourceInMicros,
        earliestStart - segment.timelineStartMicros,
      )
      const maxDelta = segmentDuration(segment) - MIN_SEGMENT_MICROS
      const delta = Math.min(Math.max(requested, minDelta), maxDelta)

      content.sourceInMicros += delta
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

    if (content.kind === 'video') {
      const source = requireSource(project, content.sourceId)
      const maxDuration = source.durationMicros - content.sourceInMicros
      const duration = Math.min(
        Math.max(requestedDuration, MIN_SEGMENT_MICROS),
        maxDuration,
      )

      content.sourceOutMicros = content.sourceInMicros + duration
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
  },

  /**
   * Sets the fixed transform of a segment. Only the fields given change, so
   * nudging x does not reset a scale set earlier.
   */
  setSegmentTransform(project: Project, args: SegmentTransformInput): void {
    const { segment } = requireSegment(project, args.segmentId)
    const next: Partial<Transform> = { ...segment.transform }

    for (const property of ANIMATABLE_PROPERTIES) {
      const value = args[property]
      if (value === undefined) continue
      next[property] = clampTransformValue(property, value)
    }

    segment.transform = next
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
    const value = clampTransformValue(args.property, args.value)

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
      if (content.kind === 'video') {
        const cutAtSource = content.sourceInMicros + offset
        secondContent = {
          kind: 'video',
          sourceId: content.sourceId,
          sourceInMicros: cutAtSource,
          sourceOutMicros: content.sourceOutMicros,
        }
        content.sourceOutMicros = cutAtSource
      } else {
        secondContent = {
          ...content,
          durationMicros: content.durationMicros - offset,
        }
        content.durationMicros = offset
      }

      track.segments.splice(index + 1, 0, {
        id: input.newSegmentId,
        timelineStartMicros: input.timelineMicros,
        content: secondContent,
      })
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

export const splitSegmentAt = (
  project: Project,
  input: SplitSegmentInput,
): Project => produce(project, (draft) => mutators.splitSegmentAt(draft, input))

export const setSegmentTransform = (
  project: Project,
  args: SegmentTransformInput,
): Project =>
  produce(project, (draft) => mutators.setSegmentTransform(draft, args))

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

    const content = segment.content as VideoContent
    return {
      track,
      segment,
      sourceMicros:
        content.sourceInMicros + (timelineMicros - segment.timelineStartMicros),
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

    const segment = track.segments.find((candidate) =>
      segmentCovers(candidate, timelineMicros),
    )
    if (!segment) continue

    const content = segment.content as VideoContent
    stack.push({
      track,
      segment,
      sourceMicros:
        content.sourceInMicros + (timelineMicros - segment.timelineStartMicros),
    })

    if (
      occludesEverything(
        segment,
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
