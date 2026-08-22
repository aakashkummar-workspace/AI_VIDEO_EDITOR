import { produce } from 'immer'
import {
  MIN_CLIP_MICROS,
  clipDuration,
  clipEndMicros,
  type Clip,
  type Project,
  type Source,
} from './types'

/**
 * Every operation exists twice: a `mutators.*` recipe that edits an immer
 * draft, and a pure `(project, args) => Project` wrapper below it.
 *
 * The wrappers are the public API and what the tests exercise. The store uses
 * the recipes directly with produceWithPatches, because a recipe that mutates
 * yields fine-grained undo patches while one that returns a new object only
 * yields a single whole-state replace.
 */

function assertIntegerMicros(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new Error(`${label} must be an integer number of microseconds.`)
  }
}

function clipIndexById(project: Project, clipId: string): number {
  const index = project.videoTrack.clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) {
    throw new Error(`No clip with id ${clipId}.`)
  }
  return index
}

function requireSource(project: Project, sourceId: string): Source {
  const source = project.sources[sourceId]
  if (!source) {
    throw new Error(`No source with id ${sourceId}.`)
  }
  return source
}

function sortClips(project: Project): void {
  project.videoTrack.clips.sort(
    (a, b) => a.timelineStartMicros - b.timelineStartMicros,
  )
}

/** Throws if `candidate` would overlap any clip other than itself. */
function assertNoOverlap(project: Project, candidate: Clip): void {
  const start = candidate.timelineStartMicros
  const end = clipEndMicros(candidate)

  for (const clip of project.videoTrack.clips) {
    if (clip.id === candidate.id) continue
    if (start < clipEndMicros(clip) && clip.timelineStartMicros < end) {
      throw new Error(`A clip at ${start}us would overlap clip ${clip.id}.`)
    }
  }
}

export type AddClipInput = {
  id: string
  sourceId: string
  sourceInMicros: number
  sourceOutMicros: number
  timelineStartMicros: number
}

export type SplitClipInput = {
  timelineMicros: number
  /** Id for the second half. Passed in so the operation stays deterministic. */
  newClipId: string
}

export type TrimInput = {
  clipId: string
  /** Where the trimmed edge should land on the timeline. */
  timelineMicros: number
}

export type MoveClipInput = {
  clipId: string
  timelineStartMicros: number
}

export const mutators = {
  addSource(project: Project, source: Source): void {
    assertIntegerMicros(source.durationMicros, 'durationMicros')
    if (source.durationMicros <= 0) {
      throw new Error('A source must have a positive duration.')
    }
    project.sources[source.id] = { ...source }
  },

  addClip(project: Project, input: AddClipInput): void {
    assertIntegerMicros(input.sourceInMicros, 'sourceInMicros')
    assertIntegerMicros(input.sourceOutMicros, 'sourceOutMicros')
    assertIntegerMicros(input.timelineStartMicros, 'timelineStartMicros')

    const source = requireSource(project, input.sourceId)

    if (project.videoTrack.clips.some((clip) => clip.id === input.id)) {
      throw new Error(`A clip with id ${input.id} already exists.`)
    }
    if (input.timelineStartMicros < 0) {
      throw new Error(
        'A clip cannot start before the beginning of the timeline.',
      )
    }
    if (
      input.sourceInMicros < 0 ||
      input.sourceOutMicros > source.durationMicros
    ) {
      throw new Error(
        `Clip range ${input.sourceInMicros}..${input.sourceOutMicros}us falls` +
          ` outside source ${source.id} (0..${source.durationMicros}us).`,
      )
    }
    if (input.sourceOutMicros - input.sourceInMicros < MIN_CLIP_MICROS) {
      throw new Error('A clip must have a positive duration.')
    }

    const clip: Clip = { ...input }
    assertNoOverlap(project, clip)

    project.videoTrack.clips.push(clip)
    sortClips(project)
  },

  removeClip(project: Project, clipId: string): void {
    const index = clipIndexById(project, clipId)
    project.videoTrack.clips.splice(index, 1)
  },

  /** Moves a clip whole, keeping its source range. Throws rather than clamping. */
  moveClip(project: Project, args: MoveClipInput): void {
    assertIntegerMicros(args.timelineStartMicros, 'timelineStartMicros')

    if (args.timelineStartMicros < 0) {
      throw new Error(
        'A clip cannot start before the beginning of the timeline.',
      )
    }

    const index = clipIndexById(project, args.clipId)
    const clip = project.videoTrack.clips[index]!
    const moved: Clip = {
      ...clip,
      timelineStartMicros: args.timelineStartMicros,
    }

    assertNoOverlap(project, moved)

    clip.timelineStartMicros = args.timelineStartMicros
    sortClips(project)
  },

  /**
   * Drags the head of a clip. The timeline start and the source in-point move
   * together, so the frames under the clip stay put. Clamped to the source's
   * real start, to the previous clip, and to a positive duration.
   */
  trimClipStart(project: Project, args: TrimInput): void {
    assertIntegerMicros(args.timelineMicros, 'timelineMicros')

    const index = clipIndexById(project, args.clipId)
    const clip = project.videoTrack.clips[index]!
    const previous = project.videoTrack.clips[index - 1]
    const earliestStart = previous ? clipEndMicros(previous) : 0

    const requested = args.timelineMicros - clip.timelineStartMicros
    const minDelta = Math.max(
      -clip.sourceInMicros,
      earliestStart - clip.timelineStartMicros,
    )
    const maxDelta = clipDuration(clip) - MIN_CLIP_MICROS
    const delta = Math.min(Math.max(requested, minDelta), maxDelta)

    clip.sourceInMicros += delta
    clip.timelineStartMicros += delta
  },

  /**
   * Drags the tail of a clip. Clamped to the source's real end, to the next
   * clip, and to a positive duration.
   */
  trimClipEnd(project: Project, args: TrimInput): void {
    assertIntegerMicros(args.timelineMicros, 'timelineMicros')

    const index = clipIndexById(project, args.clipId)
    const clip = project.videoTrack.clips[index]!
    const source = requireSource(project, clip.sourceId)
    const next = project.videoTrack.clips[index + 1]

    const latestEnd = next ? next.timelineStartMicros : Number.MAX_SAFE_INTEGER
    const requestedDuration =
      Math.min(args.timelineMicros, latestEnd) - clip.timelineStartMicros
    const maxDuration = source.durationMicros - clip.sourceInMicros
    const duration = Math.min(
      Math.max(requestedDuration, MIN_CLIP_MICROS),
      maxDuration,
    )

    clip.sourceOutMicros = clip.sourceInMicros + duration
  },

  /**
   * Cuts the clip under `timelineMicros` in two. A cut in empty space, or
   * exactly on a clip boundary, is a no-op: neither half may be empty.
   */
  splitClipAt(project: Project, input: SplitClipInput): void {
    assertIntegerMicros(input.timelineMicros, 'timelineMicros')

    const index = project.videoTrack.clips.findIndex(
      (clip) =>
        clip.timelineStartMicros < input.timelineMicros &&
        input.timelineMicros < clipEndMicros(clip),
    )
    if (index < 0) return

    const clip = project.videoTrack.clips[index]!
    if (project.videoTrack.clips.some((other) => other.id === input.newClipId)) {
      throw new Error(`A clip with id ${input.newClipId} already exists.`)
    }

    const offset = input.timelineMicros - clip.timelineStartMicros
    const cutAtSource = clip.sourceInMicros + offset

    const second: Clip = {
      id: input.newClipId,
      sourceId: clip.sourceId,
      sourceInMicros: cutAtSource,
      sourceOutMicros: clip.sourceOutMicros,
      timelineStartMicros: input.timelineMicros,
    }

    clip.sourceOutMicros = cutAtSource
    project.videoTrack.clips.splice(index + 1, 0, second)
  },
}

export const addSource = (project: Project, source: Source): Project =>
  produce(project, (draft) => mutators.addSource(draft, source))

export const addClip = (project: Project, input: AddClipInput): Project =>
  produce(project, (draft) => mutators.addClip(draft, input))

export const removeClip = (project: Project, clipId: string): Project =>
  produce(project, (draft) => mutators.removeClip(draft, clipId))

export const moveClip = (project: Project, args: MoveClipInput): Project =>
  produce(project, (draft) => mutators.moveClip(draft, args))

export const trimClipStart = (project: Project, args: TrimInput): Project =>
  produce(project, (draft) => mutators.trimClipStart(draft, args))

export const trimClipEnd = (project: Project, args: TrimInput): Project =>
  produce(project, (draft) => mutators.trimClipEnd(draft, args))

export const splitClipAt = (project: Project, input: SplitClipInput): Project =>
  produce(project, (draft) => mutators.splitClipAt(draft, input))

/** Exclusive end of the last clip, or 0 for an empty timeline. */
export function timelineDuration(project: Project): number {
  return project.videoTrack.clips.reduce(
    (end, clip) => Math.max(end, clipEndMicros(clip)),
    0,
  )
}

/** Which clip covers `timelineMicros`, and where that lands in its source. */
export function clipAt(
  project: Project,
  timelineMicros: number,
): { clip: Clip; sourceMicros: number } | null {
  const clip = project.videoTrack.clips.find(
    (candidate) =>
      candidate.timelineStartMicros <= timelineMicros &&
      timelineMicros < clipEndMicros(candidate),
  )
  if (!clip) return null

  return {
    clip,
    sourceMicros:
      clip.sourceInMicros + (timelineMicros - clip.timelineStartMicros),
  }
}
