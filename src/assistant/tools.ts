/**
 * The edits a model is allowed to ask for.
 *
 * These are not new operations. Every one of them lands on a mutator from
 * `operations.ts` - the same mutator the buttons and the keyboard shortcuts
 * reach. The assistant is a third route to the existing edits, exactly as the
 * action strip is a second one, and it must never become a second
 * implementation of them.
 *
 * Two rules here remove whole classes of failure:
 *
 * - IDS ARE MINTED, NEVER ACCEPTED. `splitSegmentAt`, `duplicateSegment`,
 *   `addSegment` and `addEffect` all take a caller-supplied id so they stay
 *   deterministic. Letting a model invent those invites collisions with ids it
 *   cannot see, so the id is in no schema: the dispatcher makes one and reports
 *   it back.
 * - SECONDS COME IN, MICROSECONDS GO ON. This and `describe.ts` are the only
 *   places outside the mediabunny sink that speak seconds. Conversion happens
 *   in `micros()` below and nowhere after it, so no float second ever reaches
 *   an operation.
 *
 * Dispatch is PURE: it takes a project and returns a new one. That is what lets
 * a whole run be planned against a scratch copy without touching the store, and
 * it is what lets these be tested without a network.
 */

import { produce } from 'immer'
import { secondsToMicros } from '../playback'
import { mutators } from '../timeline/operations'
import {
  ANIMATABLE_PROPERTIES,
  BLEND_MODES,
  EFFECT_KINDS,
  FONT_FAMILIES,
  MASK_SHAPES,
  TEXT_ALIGNMENTS,
  TRANSITION_KINDS,
  findSegment,
  segmentEndMicros,
  segmentLabel,
  soundContent,
  type EffectKind,
  type Project,
  type Segment,
} from '../timeline/types'

type MutatorName = keyof typeof mutators
type Args = Record<string, unknown>

/** EFFECT_KINDS is keyed by kind, so the list of kinds is its keys. */
const EFFECT_KIND_NAMES = Object.keys(EFFECT_KINDS) as EffectKind[]

/**
 * Only the subset of JSON Schema these tools need.
 *
 * `ranges` is the one compound kind, and it exists for exactly one tool: a list
 * of {fromSeconds, toSeconds} in SOURCE time. Cutting a talk to its transcript
 * is a list of removals or it is nothing, and asking a model to reach the same
 * result through forty splits and deletes - each one moving the ids and the
 * times the next one needs - is asking it to fail.
 */
type Field = {
  type: 'string' | 'number' | 'boolean' | 'ranges'
  description: string
  enum?: readonly string[]
}

/** A stretch of SOURCE time, as the model speaks it. */
export type Range = { fromSeconds: number; toSeconds: number }

type ToolSpec = {
  name: string
  mutator: MutatorName
  description: string
  fields: Record<string, Field>
  required: string[]
  resolve: (project: Project, args: Args, mintId: () => string) => unknown
}

/* -------------------------------------------------------------------------- */
/* Reading arguments                                                           */
/*                                                                             */
/* These throw rather than coerce. A thrown message goes back to the model as a */
/* failed tool result, which is how it learns what it got wrong - a silently    */
/* coerced argument would instead produce a confidently wrong edit.             */
/* -------------------------------------------------------------------------- */

function str(args: Args, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${key} must be a non-empty string.`)
  }
  return value
}

function optStr(args: Args, key: string): string | undefined {
  return args[key] === undefined ? undefined : str(args, key)
}

function num(args: Args, key: string): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number.`)
  }
  return value
}

function optNum(args: Args, key: string): number | undefined {
  return args[key] === undefined ? undefined : num(args, key)
}

function optBool(args: Args, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(`${key} must be true or false.`)
  }
  return value
}

function oneOf<T extends string>(
  args: Args,
  key: string,
  allowed: readonly T[],
): T {
  const value = str(args, key)
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${key} must be one of: ${allowed.join(', ')}.`)
  }
  return value as T
}

/** The one place a second becomes a microsecond for the assistant. */
function micros(args: Args, key: string): number {
  return secondsToMicros(num(args, key))
}

/** A list of source-time ranges, checked one field at a time like the rest. */
function ranges(args: Args, key: string): Range[] {
  const value = args[key]
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${key} must be a non-empty list of ranges.`)
  }

  return value.map((entry, index) => {
    const at = `${key}[${index}]`
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${at} must be an object with fromSeconds and toSeconds.`)
    }
    const from = (entry as Args)['fromSeconds']
    const to = (entry as Args)['toSeconds']
    if (typeof from !== 'number' || !Number.isFinite(from)) {
      throw new Error(`${at}.fromSeconds must be a finite number.`)
    }
    if (typeof to !== 'number' || !Number.isFinite(to)) {
      throw new Error(`${at}.toSeconds must be a finite number.`)
    }
    if (to <= from) {
      throw new Error(`${at} must end after it starts.`)
    }
    return { fromSeconds: from, toSeconds: to }
  })
}

/**
 * What is LEFT of a segment's source range once some ranges are taken out of it.
 *
 * The model is asked what to remove because that is what a person says - "cut
 * the bit where I lose my thread" - while `keepSourceSpans` is written in terms
 * of what survives, because that is what the timeline has to be rebuilt from.
 * Inverting here means neither side has to think in the other's terms.
 */
function keptSpans(
  segment: Segment,
  cuts: Range[],
): { startMicros: number; endMicros: number }[] {
  const sound = soundContent(segment)
  if (!sound) throw new Error('That segment has no source to cut parts out of.')

  // Clamped and merged before inverting: overlapping removals are a perfectly
  // reasonable thing to ask for, and two lines of a transcript can share a
  // moment. keepSourceSpans would refuse the overlap they produce.
  const merged: { startMicros: number; endMicros: number }[] = []
  for (const cut of [...cuts].sort((a, b) => a.fromSeconds - b.fromSeconds)) {
    const startMicros = Math.max(
      sound.sourceInMicros,
      secondsToMicros(cut.fromSeconds),
    )
    const endMicros = Math.min(
      sound.sourceOutMicros,
      secondsToMicros(cut.toSeconds),
    )
    if (endMicros <= startMicros) continue

    const last = merged[merged.length - 1]
    if (last && startMicros <= last.endMicros) {
      last.endMicros = Math.max(last.endMicros, endMicros)
    } else {
      merged.push({ startMicros, endMicros })
    }
  }

  if (merged.length === 0) {
    throw new Error(
      'None of those ranges is inside the part of the file this segment plays.',
    )
  }

  const kept: { startMicros: number; endMicros: number }[] = []
  let at = sound.sourceInMicros
  for (const cut of merged) {
    if (cut.startMicros > at) {
      kept.push({ startMicros: at, endMicros: cut.startMicros })
    }
    at = cut.endMicros
  }
  if (at < sound.sourceOutMicros) {
    kept.push({ startMicros: at, endMicros: sound.sourceOutMicros })
  }

  if (kept.length === 0) {
    throw new Error(
      'That would remove everything the segment plays. Delete it instead.',
    )
  }

  return kept
}

/** Copies through only the keys that were actually supplied. */
function withDefined<T extends object>(
  base: T,
  extra: Record<string, unknown>,
): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) out[key] = value
  }
  return out as T
}

/* -------------------------------------------------------------------------- */
/* Talking about the result                                                     */
/* -------------------------------------------------------------------------- */

function asSeconds(value: number): string {
  return `${(value / 1_000_000).toFixed(3)}s`
}

/**
 * What a segment now IS, read back from the project rather than from what was
 * asked for. Trims clamp silently, and transitions, duplicates and rate changes
 * all move later segments - so reporting the request back would tell the model
 * something untrue and it would plan its next step on that.
 */
function brief(project: Project, segmentId: string): string {
  const found = findSegment(project, segmentId)
  if (!found) return `${segmentId} (gone)`

  const { segment, track } = found
  return (
    `${segment.id} "${segmentLabel(project, segment)}" on ${track.id} ` +
    `${asSeconds(segment.timelineStartMicros)}-` +
    `${asSeconds(segmentEndMicros(segment))}`
  )
}

/**
 * What a segment is CALLED, for someone reading a plan. Never its id: those are
 * minted uuids, they are meaningless to a reader, and a list of them is the
 * fastest way to make a plan look unreviewable.
 */
function nameOf(project: Project, segmentId: string): string {
  const found = findSegment(project, segmentId)
  return found ? `"${segmentLabel(project, found.segment)}"` : 'that segment'
}

/** Where it now sits, so a plan says what moved as well as what changed. */
function spanOf(project: Project, segmentId: string): string {
  const found = findSegment(project, segmentId)
  if (!found) return ''

  return (
    ` (${asSeconds(found.segment.timelineStartMicros)}` +
    `-${asSeconds(segmentEndMicros(found.segment))})`
  )
}

/** How each edit reads in a sentence. */
const VERBS: Record<string, string> = {
  split_segment: 'Split',
  duplicate_segment: 'Duplicate',
  delete_segment: 'Delete',
  remove_spoken_ranges: 'Cut parts out of',
  move_segment: 'Move',
  trim_segment_start: 'Trim the start of',
  trim_segment_end: 'Trim the end of',
  set_speed: 'Change the speed of',
  add_transition: 'Blend into',
  remove_transition: 'Remove the transition on',
  set_properties: 'Adjust',
  add_keyframe: 'Animate',
  clear_keyframes: 'Remove the animation from',
  add_effect: 'Add an effect to',
  set_effect_amount: 'Change an effect on',
  remove_effect: 'Remove an effect from',
  set_blend_mode: 'Change how it blends:',
  set_mask: 'Mask',
  add_text: 'Add a caption',
  set_text_style: 'Restyle',
}

function firstTextTrack(project: Project): string {
  const track = project.tracks.find((candidate) => candidate.kind === 'text')
  if (!track) throw new Error('This project has no text row to put a caption on.')
  return track.id
}

/* -------------------------------------------------------------------------- */
/* The tools                                                                    */
/* -------------------------------------------------------------------------- */

const SEGMENT_ID: Field = {
  type: 'string',
  description: 'The id of the segment, as given in the project outline.',
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'split_segment',
    mutator: 'splitSegmentAt',
    description:
      'Cut whatever segment lies under a moment in two. Acts on the topmost ' +
      'row with something there unless trackId names one. Does nothing if the ' +
      'moment falls in a gap or exactly on a boundary.',
    fields: {
      atSeconds: { type: 'number', description: 'Where to cut, in seconds.' },
      trackId: { type: 'string', description: 'Optional row to cut on.' },
    },
    required: ['atSeconds'],
    resolve: (_project, args, mintId) =>
      withDefined(
        {
          timelineMicros: micros(args, 'atSeconds'),
          newSegmentId: mintId(),
        },
        { trackId: optStr(args, 'trackId') },
      ),
  },
  {
    name: 'duplicate_segment',
    mutator: 'duplicateSegment',
    description:
      'Put a copy of a segment immediately after it. On a packed row this ' +
      'moves everything after it later, so the project gets longer.',
    fields: { segmentId: SEGMENT_ID },
    required: ['segmentId'],
    resolve: (_project, args, mintId) => ({
      segmentId: str(args, 'segmentId'),
      newSegmentId: mintId(),
    }),
  },
  {
    name: 'remove_spoken_ranges',
    mutator: 'keepSourceSpans',
    description:
      'Cut one or more stretches out of a clip and close the gaps, in ONE ' +
      'step. Times are SOURCE seconds - the same clock the transcript in the ' +
      '"scripts" section uses - so a line can be cut by quoting its own start ' +
      'and end back. This is how to cut a clip to what was said: prefer it to ' +
      'a run of splits and deletes, which move the ids and times of every cut ' +
      'after them. Overlapping ranges are fine. What follows on the row is ' +
      'pulled earlier, so the project gets shorter.',
    fields: {
      segmentId: SEGMENT_ID,
      ranges: {
        type: 'ranges',
        description:
          'The stretches to cut out, each {fromSeconds, toSeconds} in source ' +
          'seconds. Order does not matter and they may overlap.',
      },
    },
    required: ['segmentId', 'ranges'],
    resolve: (project, args, mintId) => {
      const segmentId = str(args, 'segmentId')
      const found = findSegment(project, segmentId)
      if (!found) throw new Error(`There is no segment ${segmentId}.`)

      const spans = keptSpans(found.segment, ranges(args, 'ranges'))
      return {
        segmentId,
        spans,
        // One per piece after the first, which keeps the original's id.
        newSegmentIds: spans.slice(1).map(() => mintId()),
      }
    },
  },
  {
    name: 'delete_segment',
    mutator: 'removeSegment',
    description: 'Remove a segment. It leaves a gap rather than closing up.',
    fields: { segmentId: SEGMENT_ID },
    required: ['segmentId'],
    resolve: (_project, args) => str(args, 'segmentId'),
  },
  {
    name: 'move_segment',
    mutator: 'moveSegment',
    description:
      'Move a segment to a new start time, optionally onto another row of the ' +
      'same kind. Refuses to overlap anything on a video or audio row.',
    fields: {
      segmentId: SEGMENT_ID,
      startSeconds: { type: 'number', description: 'New start, in seconds.' },
      trackId: { type: 'string', description: 'Optional row to move it to.' },
    },
    required: ['segmentId', 'startSeconds'],
    resolve: (_project, args) =>
      withDefined(
        {
          segmentId: str(args, 'segmentId'),
          timelineStartMicros: micros(args, 'startSeconds'),
        },
        { trackId: optStr(args, 'trackId') },
      ),
  },
  {
    name: 'trim_segment_start',
    mutator: 'trimSegmentStart',
    description:
      'Move a segment opening edge to a moment. Clamps silently against its ' +
      'neighbour and against running out of source, so read the result.',
    fields: {
      segmentId: SEGMENT_ID,
      atSeconds: { type: 'number', description: 'Where the edge lands.' },
    },
    required: ['segmentId', 'atSeconds'],
    resolve: (_project, args) => ({
      segmentId: str(args, 'segmentId'),
      timelineMicros: micros(args, 'atSeconds'),
    }),
  },
  {
    name: 'trim_segment_end',
    mutator: 'trimSegmentEnd',
    description:
      'Move a segment closing edge to a moment. Clamps silently, as ' +
      'trim_segment_start does.',
    fields: {
      segmentId: SEGMENT_ID,
      atSeconds: { type: 'number', description: 'Where the edge lands.' },
    },
    required: ['segmentId', 'atSeconds'],
    resolve: (_project, args) => ({
      segmentId: str(args, 'segmentId'),
      timelineMicros: micros(args, 'atSeconds'),
    }),
  },
  {
    name: 'set_speed',
    mutator: 'setSegmentRate',
    description:
      'Play a segment faster or slower, from 0.25x to 4x. Its head stays put ' +
      'and its tail moves, so later segments on a packed row shift. This ' +
      'shifts pitch, like speeding up a tape. Text has no speed.',
    fields: {
      segmentId: SEGMENT_ID,
      rate: { type: 'number', description: '1 is normal, 2 is twice as fast.' },
    },
    required: ['segmentId', 'rate'],
    resolve: (_project, args) => ({
      segmentId: str(args, 'segmentId'),
      rate: num(args, 'rate'),
    }),
  },
  {
    name: 'add_transition',
    mutator: 'setTransition',
    description:
      'Blend a segment out of the one before it. Named on the INCOMING ' +
      'segment, needs the two to actually meet, and pulls this segment and ' +
      'everything after it earlier - so the project gets shorter.',
    fields: {
      segmentId: {
        type: 'string',
        description: 'The incoming segment, i.e. the later of the two.',
      },
      kind: {
        type: 'string',
        description: 'Which blend.',
        enum: TRANSITION_KINDS,
      },
      durationSeconds: {
        type: 'number',
        description: 'How long the blend lasts, in seconds.',
      },
    },
    required: ['segmentId', 'kind', 'durationSeconds'],
    resolve: (_project, args) => ({
      segmentId: str(args, 'segmentId'),
      kind: oneOf(args, 'kind', TRANSITION_KINDS),
      durationMicros: micros(args, 'durationSeconds'),
    }),
  },
  {
    name: 'remove_transition',
    mutator: 'removeTransition',
    description:
      'Take the transition off a segment, giving back the time it borrowed.',
    fields: { segmentId: SEGMENT_ID },
    required: ['segmentId'],
    resolve: (_project, args) => str(args, 'segmentId'),
  },
  {
    name: 'set_properties',
    mutator: 'setSegmentProperties',
    description:
      'Set any of a segment fixed values. Only the ones given change. volume ' +
      'applies to anything that makes a sound; the rest need a picture. A ' +
      'property that is animated is driven by its keyframes instead.',
    fields: {
      segmentId: SEGMENT_ID,
      scale: { type: 'number', description: '1 is original size.' },
      x: { type: 'number', description: 'Horizontal offset in pixels.' },
      y: { type: 'number', description: 'Vertical offset in pixels.' },
      opacity: { type: 'number', description: '0 to 1.' },
      volume: { type: 'number', description: '0 to 4, 1 is unchanged.' },
    },
    required: ['segmentId'],
    resolve: (_project, args) =>
      withDefined(
        { segmentId: str(args, 'segmentId') },
        {
          scale: optNum(args, 'scale'),
          x: optNum(args, 'x'),
          y: optNum(args, 'y'),
          opacity: optNum(args, 'opacity'),
          volume: optNum(args, 'volume'),
        },
      ),
  },
  {
    name: 'add_keyframe',
    mutator: 'addKeyframe',
    description:
      'Pin a property to a value at a moment measured FROM THE SEGMENT OWN ' +
      'START, not from the timeline - so the animation survives moving it. Two ' +
      'keyframes make a ramp. A keyframe at an offset that already has one ' +
      'replaces it.',
    fields: {
      segmentId: SEGMENT_ID,
      property: {
        type: 'string',
        description: 'Which value to animate.',
        enum: ANIMATABLE_PROPERTIES,
      },
      offsetSeconds: {
        type: 'number',
        description: 'Seconds after the segment starts. 0 is its first frame.',
      },
      value: { type: 'number', description: 'The value at that moment.' },
    },
    required: ['segmentId', 'property', 'offsetSeconds', 'value'],
    resolve: (_project, args) => ({
      segmentId: str(args, 'segmentId'),
      property: oneOf(args, 'property', ANIMATABLE_PROPERTIES),
      offsetMicros: micros(args, 'offsetSeconds'),
      value: num(args, 'value'),
    }),
  },
  {
    name: 'clear_keyframes',
    mutator: 'clearKeyframes',
    description:
      'Remove the animation from one property, or from all of them if no ' +
      'property is named. The fixed value takes over again.',
    fields: {
      segmentId: SEGMENT_ID,
      property: {
        type: 'string',
        description: 'Optional single property to clear.',
        enum: ANIMATABLE_PROPERTIES,
      },
    },
    required: ['segmentId'],
    resolve: (_project, args) =>
      withDefined(
        { segmentId: str(args, 'segmentId') },
        {
          property:
            args['property'] === undefined
              ? undefined
              : oneOf(args, 'property', ANIMATABLE_PROPERTIES),
        },
      ),
  },
  {
    name: 'add_effect',
    mutator: 'addEffect',
    description:
      'Put a colour effect on a segment. Effects apply in the order they were ' +
      'added. Leaving amount out uses the effect neutral value, which looks ' +
      'like nothing at all.',
    fields: {
      segmentId: SEGMENT_ID,
      kind: {
        type: 'string',
        description: 'Which effect.',
        enum: EFFECT_KIND_NAMES,
      },
      amount: {
        type: 'number',
        description:
          'brightness/contrast/saturate: 1 is neutral, 0-3. grayscale: 0-1. ' +
          'blur: pixels, 0-64.',
      },
    },
    required: ['segmentId', 'kind'],
    resolve: (_project, args, mintId) =>
      withDefined(
        {
          segmentId: str(args, 'segmentId'),
          id: mintId(),
          kind: oneOf(args, 'kind', EFFECT_KIND_NAMES),
        },
        { amount: optNum(args, 'amount') },
      ),
  },
  {
    name: 'set_effect_amount',
    mutator: 'setEffectAmount',
    description: 'Change how strong an effect already on a segment is.',
    fields: {
      segmentId: SEGMENT_ID,
      effectId: { type: 'string', description: 'The effect id.' },
      amount: { type: 'number', description: 'The new amount.' },
    },
    required: ['segmentId', 'effectId', 'amount'],
    resolve: (_project, args) => ({
      segmentId: str(args, 'segmentId'),
      effectId: str(args, 'effectId'),
      amount: num(args, 'amount'),
    }),
  },
  {
    name: 'remove_effect',
    mutator: 'removeEffect',
    description: 'Take an effect off a segment.',
    fields: {
      segmentId: SEGMENT_ID,
      effectId: { type: 'string', description: 'The effect id.' },
    },
    required: ['segmentId', 'effectId'],
    resolve: (_project, args) => ({
      segmentId: str(args, 'segmentId'),
      effectId: str(args, 'effectId'),
    }),
  },
  {
    name: 'set_blend_mode',
    mutator: 'setSegmentBlendMode',
    description:
      'Change how a segment composites over what is under it. "normal" is ' +
      'plain stacking and removes the setting.',
    fields: {
      segmentId: SEGMENT_ID,
      blendMode: {
        type: 'string',
        description: 'Which mode.',
        enum: BLEND_MODES,
      },
    },
    required: ['segmentId', 'blendMode'],
    resolve: (_project, args) => ({
      segmentId: str(args, 'segmentId'),
      blendMode: oneOf(args, 'blendMode', BLEND_MODES),
    }),
  },
  {
    name: 'set_mask',
    mutator: 'setSegmentMask',
    description:
      'Cut a segment to a shape, in composition pixels. Only the given fields ' +
      'change; a segment with no mask yet gets the middle half of the frame.',
    fields: {
      segmentId: SEGMENT_ID,
      shape: { type: 'string', description: 'Mask shape.', enum: MASK_SHAPES },
      x: { type: 'number', description: 'Left edge, in pixels.' },
      y: { type: 'number', description: 'Top edge, in pixels.' },
      width: { type: 'number', description: 'Width in pixels.' },
      height: { type: 'number', description: 'Height in pixels.' },
      featherPx: { type: 'number', description: 'Softness of the edge.' },
      inverted: { type: 'boolean', description: 'Keep the outside instead.' },
    },
    required: ['segmentId'],
    resolve: (_project, args) =>
      withDefined(
        { segmentId: str(args, 'segmentId') },
        {
          shape:
            args['shape'] === undefined
              ? undefined
              : oneOf(args, 'shape', MASK_SHAPES),
          x: optNum(args, 'x'),
          y: optNum(args, 'y'),
          width: optNum(args, 'width'),
          height: optNum(args, 'height'),
          featherPx: optNum(args, 'featherPx'),
          inverted: optBool(args, 'inverted'),
        },
      ),
  },
  {
    name: 'add_text',
    mutator: 'addSegment',
    description:
      'Put a caption on a text row. Text rows are the only ones where ' +
      'segments may overlap, so it can go anywhere.',
    fields: {
      text: { type: 'string', description: 'The words to draw.' },
      startSeconds: { type: 'number', description: 'When it appears.' },
      durationSeconds: { type: 'number', description: 'How long it stays.' },
      sizePx: { type: 'number', description: 'Type size in pixels.' },
      color: { type: 'string', description: 'A CSS colour, e.g. #ffffff.' },
      trackId: { type: 'string', description: 'Optional text row to use.' },
    },
    required: ['text', 'startSeconds', 'durationSeconds'],
    resolve: (project, args, mintId) => {
      const { width, height } = project.composition
      const segment: Segment = {
        id: mintId(),
        timelineStartMicros: micros(args, 'startSeconds'),
        content: {
          kind: 'text',
          content: str(args, 'text'),
          // The middle of the frame, which is where a caption dropped without
          // instructions is least likely to be in the way.
          x: Math.round(width / 2),
          y: Math.round(height / 2),
          sizePx: optNum(args, 'sizePx') ?? Math.round(height / 12),
          color: optStr(args, 'color') ?? '#ffffff',
          durationMicros: micros(args, 'durationSeconds'),
          align: 'center',
        },
      }

      return {
        trackId: optStr(args, 'trackId') ?? firstTextTrack(project),
        segment,
      }
    },
  },
  {
    name: 'set_text_style',
    mutator: 'setTextStyle',
    description:
      'Change a caption words or its look. Only the given fields change. Only ' +
      'generic font families exist, deliberately: a named webfont could lose ' +
      'its loading race and make the export differ from the preview.',
    fields: {
      segmentId: SEGMENT_ID,
      content: { type: 'string', description: 'New words. Newlines allowed.' },
      x: { type: 'number', description: 'Horizontal position in pixels.' },
      y: { type: 'number', description: 'Vertical position in pixels.' },
      sizePx: { type: 'number', description: 'Type size in pixels.' },
      color: { type: 'string', description: 'A CSS colour.' },
      fontFamily: {
        type: 'string',
        description: 'Which generic family.',
        enum: FONT_FAMILIES,
      },
      bold: { type: 'boolean', description: 'Bold or not.' },
      italic: { type: 'boolean', description: 'Italic or not.' },
      align: {
        type: 'string',
        description: 'How lines line up.',
        enum: TEXT_ALIGNMENTS,
      },
      outlineWidthPx: { type: 'number', description: 'Outline thickness.' },
      outlineColor: { type: 'string', description: 'Outline colour.' },
      backgroundColor: {
        type: 'string',
        description: 'Box colour behind the words. Empty string removes it.',
      },
    },
    required: ['segmentId'],
    resolve: (_project, args) =>
      withDefined(
        { segmentId: str(args, 'segmentId') },
        {
          content: optStr(args, 'content'),
          x: optNum(args, 'x'),
          y: optNum(args, 'y'),
          sizePx: optNum(args, 'sizePx'),
          color: optStr(args, 'color'),
          fontFamily:
            args['fontFamily'] === undefined
              ? undefined
              : oneOf(args, 'fontFamily', FONT_FAMILIES),
          bold: optBool(args, 'bold'),
          italic: optBool(args, 'italic'),
          align:
            args['align'] === undefined
              ? undefined
              : oneOf(args, 'align', TEXT_ALIGNMENTS),
          outlineWidthPx: optNum(args, 'outlineWidthPx'),
          outlineColor: optStr(args, 'outlineColor'),
          // Deliberately not optStr: '' is how a background box is removed.
          backgroundColor:
            args['backgroundColor'] === undefined
              ? undefined
              : String(args['backgroundColor']),
        },
      ),
  },
]

/** One applied edit, kept so an approved plan can be replayed exactly. */
export type PlanStep = {
  tool: string
  mutator: MutatorName
  /** The resolved mutator input - ids minted, seconds already microseconds. */
  input: unknown
  /**
   * What happened, for the MODEL. Carries the ids it needs to name the things
   * it has just made in the steps that follow.
   */
  summary: string
  /**
   * The same thing, for the PERSON deciding whether to apply it. Names files
   * and captions rather than ids: a plan is only worth showing if it can be
   * read, and a list of uuids cannot be.
   */
  label: string
}

export type ToolDefinition = {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required: string[]
    additionalProperties: false
  }
}

/**
 * A field as JSON Schema. Only `ranges` needs expanding; the rest already are
 * one, which is why they are written in that shape to begin with.
 */
export function jsonSchemaFor(field: Field): Record<string, unknown> {
  if (field.type !== 'ranges') return { ...field }

  return {
    type: 'array',
    description: field.description,
    items: {
      type: 'object',
      properties: {
        fromSeconds: { type: 'number', description: 'Start, in source seconds.' },
        toSeconds: { type: 'number', description: 'End, in source seconds.' },
      },
      required: ['fromSeconds', 'toSeconds'],
      additionalProperties: false,
    },
  }
}

/** The schema handed to the model. Derived, so it cannot drift from dispatch. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = TOOL_SPECS.map(
  (spec) => ({
    name: spec.name,
    description: spec.description,
    input_schema: {
      type: 'object' as const,
      properties: Object.fromEntries(
        Object.entries(spec.fields).map(([name, field]) => [
          name,
          jsonSchemaFor(field),
        ]),
      ),
      required: spec.required,
      additionalProperties: false as const,
    },
  }),
)

/**
 * What to tell the model happened. Read back from the project rather than
 * echoed from the request, because trims clamp and several operations move
 * segments other than the one named.
 */
function summarize(spec: ToolSpec, after: Project, input: unknown): string {
  if (typeof input === 'string') {
    return `${spec.name}: ${spec.name === 'delete_segment' ? `${input} removed` : brief(after, input)}`
  }

  const record = input as Record<string, unknown>

  if (spec.name === 'split_segment' || spec.name === 'duplicate_segment') {
    const newId = record['newSegmentId']
    return typeof newId === 'string'
      ? `${spec.name}: new segment ${brief(after, newId)}`
      : spec.name
  }

  if (spec.name === 'remove_spoken_ranges') {
    // Which pieces exist now, not which cuts were asked for: everything after
    // them moved, and the next step has to be planned against that.
    const ids = [
      String(record['segmentId']),
      ...((record['newSegmentIds'] as string[] | undefined) ?? []),
    ]
    return `remove_spoken_ranges: ${ids.map((id) => brief(after, id)).join('; ')}`
  }

  if (spec.name === 'add_text') {
    const segment = record['segment'] as Segment | undefined
    return segment ? `add_text: ${brief(after, segment.id)}` : 'add_text'
  }

  if (spec.name === 'add_effect') {
    return (
      `add_effect: effect ${String(record['id'])} on ` +
      brief(after, String(record['segmentId']))
    )
  }

  const segmentId = record['segmentId']
  return typeof segmentId === 'string'
    ? `${spec.name}: ${brief(after, segmentId)}`
    : spec.name
}

/** How much of the source a segment plays, or null if it plays none. */
function segmentSourceLength(project: Project, segmentId: string): number | null {
  const found = findSegment(project, segmentId)
  if (!found) return null
  const sound = soundContent(found.segment)
  return sound ? sound.sourceOutMicros - sound.sourceInMicros : null
}

/**
 * The same edit said in a sentence, for whoever is deciding whether to apply
 * it. `before` is needed as well as `after` because a deletion has to be named
 * from the project that still had it in.
 */
function describeStep(
  spec: ToolSpec,
  before: Project,
  after: Project,
  input: unknown,
): string {
  const verb = VERBS[spec.name] ?? spec.name

  if (typeof input === 'string') {
    const project = spec.name === 'delete_segment' ? before : after
    return `${verb} ${nameOf(project, input)}`
  }

  const record = input as Record<string, unknown>

  if (spec.name === 'split_segment') {
    const at = record['timelineMicros'] as number
    const newId = String(record['newSegmentId'])
    // The half that was cut off is the new one; naming the ORIGINAL reads the
    // way somebody asked for it.
    return `${verb} ${nameOf(after, newId)} at ${asSeconds(at)}`
  }

  if (spec.name === 'remove_spoken_ranges') {
    const id = String(record['segmentId'])
    const spans = (record['spans'] as { startMicros: number; endMicros: number }[])
      ?? []
    const kept = spans.reduce(
      (total, span) => total + (span.endMicros - span.startMicros),
      0,
    )
    const was = segmentSourceLength(before, id)
    // How much LEAVES, which is what somebody approving a cut wants to know.
    const gone = was === null ? null : was - kept
    return gone === null
      ? `${verb} ${nameOf(before, id)}`
      : `${verb} ${nameOf(before, id)}: ${asSeconds(gone)} removed in ${
          spans.length
        } piece${spans.length === 1 ? '' : 's'}`
  }

  if (spec.name === 'add_text') {
    const segment = record['segment'] as Segment | undefined
    if (!segment) return verb
    const words = segment.content.kind === 'text' ? segment.content.content : ''
    return `${verb} "${words}"${spanOf(after, segment.id)}`
  }

  if (spec.name === 'duplicate_segment') {
    const newId = String(record['newSegmentId'])
    return `${verb} ${nameOf(after, newId)}${spanOf(after, newId)}`
  }

  const segmentId = record['segmentId']
  if (typeof segmentId !== 'string') return verb

  const target = `${nameOf(after, segmentId)}${spanOf(after, segmentId)}`

  if (spec.name === 'set_speed') {
    return `${verb} ${target} to ${String(record['rate'])}x`
  }
  if (spec.name === 'add_transition') {
    return `${verb} ${target} with a ${String(record['kind'])}`
  }
  if (spec.name === 'add_effect') {
    return `${verb} ${target}: ${String(record['kind'])}`
  }
  if (spec.name === 'set_blend_mode') {
    return `${verb} ${String(record['blendMode'])} on ${target}`
  }
  if (spec.name === 'add_keyframe') {
    return `${verb} ${String(record['property'])} on ${target}`
  }

  return `${verb} ${target}`
}

/**
 * Runs one tool against a project and hands back the new one.
 *
 * Pure, and that is the whole point: a run is planned against a scratch copy,
 * so nothing reaches the store until somebody approves it. Anything invalid
 * throws - from the argument readers above, or from the operation's own checks,
 * whose messages are written for people and read just as well to a model.
 */
export function dispatch(
  project: Project,
  name: string,
  args: Args,
  mintId: () => string = () => crypto.randomUUID(),
): { project: Project; step: PlanStep } {
  const spec = TOOL_SPECS.find((candidate) => candidate.name === name)
  if (!spec) throw new Error(`There is no tool called ${name}.`)

  const input = spec.resolve(project, args, mintId)
  const mutate = mutators[spec.mutator] as (
    draft: Project,
    input: unknown,
  ) => void

  const next = produce(project, (draft) => {
    mutate(draft, input)
  })

  return {
    project: next,
    step: {
      tool: name,
      mutator: spec.mutator,
      input,
      summary: summarize(spec, next, input),
      label: describeStep(spec, project, next, input),
    },
  }
}
