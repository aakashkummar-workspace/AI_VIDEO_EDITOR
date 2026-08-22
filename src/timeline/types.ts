/**
 * Timeline state. Everything here is plain JSON: no File objects, no GPU
 * handles, no class instances. Source files live in the source registry,
 * keyed by the same sourceId used here.
 *
 * All times are integer microseconds.
 */

/** Serializable metadata about a source file. The file itself is not here. */
export type Source = {
  id: string
  name: string
  durationMicros: number
  width: number
  height: number
}

export type Clip = {
  id: string
  sourceId: string
  /** Inclusive start of the used region within the source. */
  sourceInMicros: number
  /** Exclusive end of the used region within the source. */
  sourceOutMicros: number
  /** Where the clip's head sits on the timeline. */
  timelineStartMicros: number
}

/** Clips are always sorted by timelineStartMicros and never overlap. */
export type VideoTrack = {
  clips: Clip[]
}

export type Project = {
  sources: Record<string, Source>
  videoTrack: VideoTrack
}

/** The shortest clip the model allows. Zero and negative durations are invalid. */
export const MIN_CLIP_MICROS = 1

export function emptyProject(): Project {
  return { sources: {}, videoTrack: { clips: [] } }
}

/** Duration is derived from the source in/out points, never stored. */
export function clipDuration(clip: Clip): number {
  return clip.sourceOutMicros - clip.sourceInMicros
}

/** Exclusive end of the clip on the timeline. */
export function clipEndMicros(clip: Clip): number {
  return clip.timelineStartMicros + clipDuration(clip)
}
