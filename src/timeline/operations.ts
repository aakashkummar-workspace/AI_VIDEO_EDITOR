import { produce } from 'immer'
import {
  MIN_CLIP_MICROS,
  MIN_OVERLAY_MICROS,
  clipDuration,
  clipEndMicros,
  overlayEndMicros,
  type Clip,
  type Composition,
  type Overlay,
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

function overlayIndexById(project: Project, overlayId: string): number {
  const index = project.overlays.findIndex(
    (overlay) => overlay.id === overlayId,
  )
  if (index < 0) {
    throw new Error(`No overlay with id ${overlayId}.`)
  }
  return index
}

function sortOverlays(project: Project): void {
  project.overlays.sort((a, b) => a.timelineStartMicros - b.timelineStartMicros)
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

export type MoveOverlayInput = {
  overlayId: string
  timelineStartMicros: number
}

export type OverlayTrimInput = {
  overlayId: string
  timelineMicros: number
}

/** The editable look of an overlay: everything except when it plays. */
export type OverlayStyleInput = {
  overlayId: string
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

  addOverlay(project: Project, overlay: Overlay): void {
    assertIntegerMicros(overlay.timelineStartMicros, 'timelineStartMicros')
    assertIntegerMicros(overlay.durationMicros, 'durationMicros')

    if (project.overlays.some((existing) => existing.id === overlay.id)) {
      throw new Error(`An overlay with id ${overlay.id} already exists.`)
    }
    if (overlay.timelineStartMicros < 0) {
      throw new Error(
        'An overlay cannot start before the beginning of the timeline.',
      )
    }
    if (overlay.durationMicros < MIN_OVERLAY_MICROS) {
      throw new Error('An overlay must have a positive duration.')
    }
    if (overlay.sizePx <= 0) {
      throw new Error('An overlay must have a positive size.')
    }

    project.overlays.push({ ...overlay })
    sortOverlays(project)
  },

  removeOverlay(project: Project, overlayId: string): void {
    project.overlays.splice(overlayIndexById(project, overlayId), 1)
  },

  /** Overlays may sit on top of one another, so this only clamps to zero. */
  moveOverlay(project: Project, args: MoveOverlayInput): void {
    assertIntegerMicros(args.timelineStartMicros, 'timelineStartMicros')

    const overlay = project.overlays[overlayIndexById(project, args.overlayId)]!
    overlay.timelineStartMicros = Math.max(0, args.timelineStartMicros)
    sortOverlays(project)
  },

  /** Drags the head, holding the tail still. */
  trimOverlayStart(project: Project, args: OverlayTrimInput): void {
    assertIntegerMicros(args.timelineMicros, 'timelineMicros')

    const overlay = project.overlays[overlayIndexById(project, args.overlayId)]!
    const end = overlayEndMicros(overlay)
    const start = Math.min(
      Math.max(0, args.timelineMicros),
      end - MIN_OVERLAY_MICROS,
    )

    overlay.timelineStartMicros = start
    overlay.durationMicros = end - start
    sortOverlays(project)
  },

  /** Drags the tail, holding the head still. */
  trimOverlayEnd(project: Project, args: OverlayTrimInput): void {
    assertIntegerMicros(args.timelineMicros, 'timelineMicros')

    const overlay = project.overlays[overlayIndexById(project, args.overlayId)]!
    overlay.durationMicros = Math.max(
      MIN_OVERLAY_MICROS,
      args.timelineMicros - overlay.timelineStartMicros,
    )
  },

  setOverlayStyle(project: Project, args: OverlayStyleInput): void {
    const overlay = project.overlays[overlayIndexById(project, args.overlayId)]!

    if (args.content !== undefined) overlay.content = args.content
    if (args.color !== undefined) overlay.color = args.color
    if (args.x !== undefined) overlay.x = Math.round(args.x)
    if (args.y !== undefined) overlay.y = Math.round(args.y)
    if (args.sizePx !== undefined) {
      if (args.sizePx <= 0) {
        throw new Error('An overlay must have a positive size.')
      }
      overlay.sizePx = Math.round(args.sizePx)
    }
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

export const setComposition = (
  project: Project,
  composition: Composition,
): Project =>
  produce(project, (draft) => mutators.setComposition(draft, composition))

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

export const addOverlay = (project: Project, overlay: Overlay): Project =>
  produce(project, (draft) => mutators.addOverlay(draft, overlay))

export const removeOverlay = (project: Project, overlayId: string): Project =>
  produce(project, (draft) => mutators.removeOverlay(draft, overlayId))

export const moveOverlay = (project: Project, args: MoveOverlayInput): Project =>
  produce(project, (draft) => mutators.moveOverlay(draft, args))

export const trimOverlayStart = (
  project: Project,
  args: OverlayTrimInput,
): Project => produce(project, (draft) => mutators.trimOverlayStart(draft, args))

export const trimOverlayEnd = (
  project: Project,
  args: OverlayTrimInput,
): Project => produce(project, (draft) => mutators.trimOverlayEnd(draft, args))

export const setOverlayStyle = (
  project: Project,
  args: OverlayStyleInput,
): Project => produce(project, (draft) => mutators.setOverlayStyle(draft, args))

/** Which overlays are showing at `timelineMicros`, in draw order. */
export function overlaysAt(project: Project, timelineMicros: number): Overlay[] {
  return project.overlays.filter(
    (overlay) =>
      overlay.timelineStartMicros <= timelineMicros &&
      timelineMicros < overlayEndMicros(overlay),
  )
}


/**
 * Exclusive end of the timeline: the last clip or overlay, whichever runs
 * longer. An overlay past the final clip still has to be playable.
 */
export function timelineDuration(project: Project): number {
  const clipsEnd = project.videoTrack.clips.reduce(
    (end, clip) => Math.max(end, clipEndMicros(clip)),
    0,
  )
  return project.overlays.reduce(
    (end, overlay) => Math.max(end, overlayEndMicros(overlay)),
    clipsEnd,
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
