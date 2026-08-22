/**
 * Timeline state. Everything here is plain JSON: no File objects, no GPU
 * handles, no class instances. Source files live in the source registry,
 * keyed by the same sourceId used here.
 *
 * All times are integer microseconds.
 */

/** Clockwise rotation stored in a source's metadata. */
export type Rotation = 0 | 90 | 180 | 270

/** Serializable metadata about a source file. The file itself is not here. */
export type Source = {
  id: string
  name: string
  durationMicros: number
  width: number
  height: number
  rotation: Rotation
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

/**
 * A line of text drawn over the composition for a stretch of the timeline.
 *
 * Unlike a clip it has no source, so its duration is stored rather than
 * derived, and overlays may overlap each other freely - two captions at once
 * is an ordinary thing to want.
 */
export type Overlay = {
  id: string
  content: string
  /** Top-left corner, in composition pixels. */
  x: number
  y: number
  /** Cap height in composition pixels. */
  sizePx: number
  /** Any CSS colour the canvas will accept. */
  color: string
  timelineStartMicros: number
  durationMicros: number
}

/** Clips are always sorted by timelineStartMicros and never overlap. */
export type VideoTrack = {
  clips: Clip[]
}

/**
 * The size everything renders at. Defaulted from the first source added, but
 * an ordinary editable field: a 9:16 or 1:1 composition over landscape footage
 * is a normal thing to want.
 */
export type Composition = {
  width: number
  height: number
}

export type Project = {
  composition: Composition
  sources: Record<string, Source>
  videoTrack: VideoTrack
  /** Sorted by timelineStartMicros. May overlap one another. */
  overlays: Overlay[]
}

/** The shortest clip the model allows. Zero and negative durations are invalid. */
export const MIN_CLIP_MICROS = 1

/** Likewise for an overlay. */
export const MIN_OVERLAY_MICROS = 1

/** The one font. No picker: this is not a typesetting program. */
export const OVERLAY_FONT_FAMILY = 'sans-serif'

/** Used until a source arrives to default it. */
export const DEFAULT_COMPOSITION: Composition = { width: 1920, height: 1080 }

export function emptyProject(): Project {
  return {
    composition: { ...DEFAULT_COMPOSITION },
    sources: {},
    videoTrack: { clips: [] },
    overlays: [],
  }
}

/** Duration is derived from the source in/out points, never stored. */
export function clipDuration(clip: Clip): number {
  return clip.sourceOutMicros - clip.sourceInMicros
}

/** Exclusive end of the clip on the timeline. */
export function clipEndMicros(clip: Clip): number {
  return clip.timelineStartMicros + clipDuration(clip)
}

/** Exclusive end of an overlay on the timeline. */
export function overlayEndMicros(overlay: Overlay): number {
  return overlay.timelineStartMicros + overlay.durationMicros
}
