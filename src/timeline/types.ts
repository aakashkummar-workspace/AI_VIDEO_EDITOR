/**
 * Timeline state. Everything here is plain JSON: no File objects, no GPU
 * handles, no class instances. Source files live in the source registry,
 * keyed by the same sourceId used here.
 *
 * All times are integer microseconds.
 *
 * The shape follows the one every non-linear editor converges on, CapCut
 * included: a project is an ordered stack of TRACKS, a track holds SEGMENTS,
 * and a segment points at a MATERIAL (here, a Source) or carries its own
 * content. A clip and a caption are the same kind of thing placed on
 * different rows, which is why they share one set of move and trim
 * operations rather than each having their own.
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

/**
 * A segment that shows part of a source file.
 *
 * Its duration is not stored: it is the source range, and deriving it keeps
 * the two from ever disagreeing.
 */
export type VideoContent = {
  kind: 'video'
  sourceId: string
  /** Inclusive start of the used region within the source. */
  sourceInMicros: number
  /** Exclusive end of the used region within the source. */
  sourceOutMicros: number
}

/**
 * A line of text drawn over the composition.
 *
 * Unlike a video segment it has no source, so its duration is stored rather
 * than derived.
 */
export type TextContent = {
  kind: 'text'
  content: string
  /** Top-left corner, in composition pixels. */
  x: number
  y: number
  /** Cap height in composition pixels. */
  sizePx: number
  /** Any CSS colour the canvas will accept. */
  color: string
  durationMicros: number
}

export type SegmentContent = VideoContent | TextContent

export type SegmentKind = SegmentContent['kind']

/**
 * Where a segment is drawn, relative to where it would sit on its own.
 *
 * This is a layer on top of the content, not part of it: a video segment still
 * letterboxes into the composition and a text segment still has its own x and
 * y, and the transform moves and scales the result of that. Identity means
 * "exactly where the content says", which is what a segment with no transform
 * gets.
 */
export type Transform = {
  /** Multiplier about the centre of what is being drawn. */
  scale: number
  /** Offset in composition pixels. */
  x: number
  y: number
  /** 0 is invisible, 1 is solid. */
  opacity: number
}

export const IDENTITY_TRANSFORM: Transform = {
  scale: 1,
  x: 0,
  y: 0,
  opacity: 1,
}

/** The transform fields a keyframe may animate. */
export type AnimatableProperty = keyof Transform

export const ANIMATABLE_PROPERTIES: AnimatableProperty[] = [
  'scale',
  'x',
  'y',
  'opacity',
]

/**
 * One point on a property's curve.
 *
 * The time is an offset from the segment's own head, not an absolute timeline
 * position, so moving or trimming a segment carries its animation with it
 * instead of leaving it behind.
 */
export type Keyframe = {
  offsetMicros: number
  value: number
}

/** Animated properties, by name. Absent means the static value is used. */
export type Keyframes = Partial<Record<AnimatableProperty, Keyframe[]>>

/**
 * The effects a segment can carry.
 *
 * Deliberately a closed list rather than a plugin interface. CapCut loads
 * effects as OpenFX plugins because it has to ship hundreds of them written by
 * other people; here the value of the idea is the UNIFORM CONTRACT, not the
 * dynamic loading - every effect is one named kind with one amount, applied in
 * order inside the one render function, so nothing can apply an effect in the
 * preview that the export does not.
 */
export type EffectKind =
  | 'brightness'
  | 'contrast'
  | 'saturate'
  | 'grayscale'
  | 'blur'

/**
 * What each kind means: the amount that changes nothing, the range it is
 * allowed, and how it is written as a filter function.
 *
 * The neutral value matters as much as the range: an effect sitting at neutral
 * has to render identically to no effect at all, which is what lets one be
 * added without the picture jumping.
 */
export const EFFECT_KINDS: Record<
  EffectKind,
  { neutral: number; min: number; max: number; unit: string; step: number }
> = {
  brightness: { neutral: 1, min: 0, max: 3, unit: '', step: 0.05 },
  contrast: { neutral: 1, min: 0, max: 3, unit: '', step: 0.05 },
  saturate: { neutral: 1, min: 0, max: 3, unit: '', step: 0.05 },
  grayscale: { neutral: 0, min: 0, max: 1, unit: '', step: 0.05 },
  blur: { neutral: 0, min: 0, max: 64, unit: 'px', step: 1 },
}

export type Effect = {
  id: string
  kind: EffectKind
  amount: number
  /**
   * Animates `amount`. Offsets are from the segment head, exactly like a
   * transform curve, so the two behave the same way under a move or a trim.
   */
  keyframes?: Keyframe[]
}

/** One item placed on a track. */
export type Segment = {
  id: string
  /** Where the segment's head sits on the timeline. */
  timelineStartMicros: number
  content: SegmentContent
  /** Fixed transform. Missing fields fall back to identity. */
  transform?: Partial<Transform>
  /** Animation, which overrides the fixed transform for the named properties. */
  keyframes?: Keyframes
  /** Applied in order, innermost first, when the segment is drawn. */
  effects?: Effect[]
}

/**
 * A row of the timeline.
 *
 * `kind` decides both what may be dropped on the row and whether its segments
 * are allowed to overlap. Video is a single picture at any instant, so a video
 * track packs its segments end to end; two captions at once is an ordinary
 * thing to want, so a text track lets them sit on top of one another.
 */
export type TrackKind = 'video' | 'text'

export type Track = {
  id: string
  kind: TrackKind
  /** Always sorted by timelineStartMicros. */
  segments: Segment[]
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

/**
 * How hard the encoder tries. These map onto mediabunny's own presets rather
 * than to bitrates, because the sensible bitrate for a frame depends on its
 * size and the codec, and the encoder knows both.
 */
export type ExportQuality = 'low' | 'medium' | 'high' | 'very-high'

export const EXPORT_QUALITIES: ExportQuality[] = [
  'low',
  'medium',
  'high',
  'very-high',
]

/**
 * What the exported file should be, as distinct from what the project is
 * authored at.
 *
 * The composition is the canvas you edit against; this is the file that comes
 * out of it. They are usually the same and do not have to be: cutting 4K
 * footage and delivering 1080p is ordinary, and so is the reverse.
 */
export type ExportSettings = {
  /**
   * Target height in pixels. Null keeps the composition's own size, which is
   * what a project gets until someone says otherwise.
   */
  heightPx: number | null
  quality: ExportQuality
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  heightPx: null,
  quality: 'high',
}

/** The heights offered in the UI. Width follows the composition's shape. */
export const EXPORT_HEIGHTS = [480, 720, 1080, 1440, 2160]

export type Project = {
  composition: Composition
  sources: Record<string, Source>
  /** Bottom of the stack first. Later tracks draw over earlier ones. */
  tracks: Track[]
  /** Absent until someone changes it, which means the defaults. */
  exportSettings?: ExportSettings
}

/** The shortest segment the model allows. Zero and negative durations are invalid. */
export const MIN_SEGMENT_MICROS = 1

/** The one font. No picker: this is not a typesetting program. */
export const OVERLAY_FONT_FAMILY = 'sans-serif'

/** Used until a source arrives to default it. */
export const DEFAULT_COMPOSITION: Composition = { width: 1920, height: 1080 }

/** Ids of the two tracks every new project starts with. */
export const MAIN_VIDEO_TRACK_ID = 'video-1'
export const MAIN_TEXT_TRACK_ID = 'text-1'

/**
 * A new project already has one video row and one text row. An editor with no
 * rows has nowhere to drop anything, and every project needs both eventually.
 */
export function emptyProject(): Project {
  return {
    composition: { ...DEFAULT_COMPOSITION },
    sources: {},
    tracks: [
      { id: MAIN_VIDEO_TRACK_ID, kind: 'video', segments: [] },
      { id: MAIN_TEXT_TRACK_ID, kind: 'text', segments: [] },
    ],
  }
}

/** A project's export settings, with the defaults filled in. */
export function exportSettingsOf(project: Project): ExportSettings {
  return { ...DEFAULT_EXPORT_SETTINGS, ...project.exportSettings }
}

/**
 * The size the exported file is written at.
 *
 * The chosen height drives it and the width follows the composition's shape,
 * so changing the export size can never change the framing. Both come back
 * EVEN: every codec that matters wants even dimensions, and an odd one is
 * either rejected outright or quietly rounded somewhere less visible.
 */
export function exportDimensions(
  composition: Composition,
  settings: ExportSettings,
): Composition {
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)

  if (settings.heightPx === null) {
    return { width: even(composition.width), height: even(composition.height) }
  }

  const height = even(settings.heightPx)
  const width = even((composition.width * height) / composition.height)

  return { width, height }
}

/** Whether segments on a track of this kind may sit on top of one another. */
export function trackAllowsOverlap(kind: TrackKind): boolean {
  return kind === 'text'
}

/** How long a segment runs on the timeline. Derived for video, stored for text. */
export function segmentDuration(segment: Segment): number {
  const content = segment.content
  return content.kind === 'video'
    ? content.sourceOutMicros - content.sourceInMicros
    : content.durationMicros
}

/** Exclusive end of a segment on the timeline. */
export function segmentEndMicros(segment: Segment): number {
  return segment.timelineStartMicros + segmentDuration(segment)
}

/** Whether a segment covers `timelineMicros`. The tail is exclusive. */
export function segmentCovers(
  segment: Segment,
  timelineMicros: number,
): boolean {
  return (
    segment.timelineStartMicros <= timelineMicros &&
    timelineMicros < segmentEndMicros(segment)
  )
}

/**
 * A property's value at `offsetMicros`, interpolated linearly between the
 * keyframes either side of it.
 *
 * Outside the outermost keyframes the nearest one is held rather than
 * extrapolated: a curve that ran off to infinity before its first point is
 * never what anyone meant. An empty list means there is no animation, so the
 * static value stands.
 */
export function valueAt(
  keyframes: readonly Keyframe[],
  offsetMicros: number,
  fallback: number,
): number {
  if (keyframes.length === 0) return fallback

  const first = keyframes[0]!
  if (offsetMicros <= first.offsetMicros) return first.value

  const last = keyframes[keyframes.length - 1]!
  if (offsetMicros >= last.offsetMicros) return last.value

  for (let i = 1; i < keyframes.length; i++) {
    const after = keyframes[i]!
    if (after.offsetMicros < offsetMicros) continue

    const before = keyframes[i - 1]!
    const span = after.offsetMicros - before.offsetMicros
    if (span <= 0) return after.value

    const t = (offsetMicros - before.offsetMicros) / span
    return before.value + (after.value - before.value) * t
  }

  return last.value
}

/**
 * How a segment should be drawn at a moment on the TIMELINE.
 *
 * Resolved rather than stored, like a segment's duration: the keyframes are
 * the truth and this is what they come out as. Both the preview and the export
 * call this from inside the one render function, so an animation cannot play
 * differently in the two.
 */
export function transformAt(
  segment: Segment,
  timelineMicros: number,
): Transform {
  const base: Transform = { ...IDENTITY_TRANSFORM, ...segment.transform }
  const keyframes = segment.keyframes
  if (!keyframes) return base

  const offsetMicros = timelineMicros - segment.timelineStartMicros
  const resolved = { ...base }

  for (const property of ANIMATABLE_PROPERTIES) {
    const curve = keyframes[property]
    if (!curve || curve.length === 0) continue
    resolved[property] = valueAt(curve, offsetMicros, base[property])
  }

  return resolved
}

/** Keeps an effect amount inside what its kind allows. */
export function clampEffectAmount(kind: EffectKind, amount: number): number {
  const spec = EFFECT_KINDS[kind]
  if (!spec) throw new Error(`Unknown effect kind ${kind}.`)
  if (!Number.isFinite(amount)) {
    throw new Error('An effect amount must be a finite number.')
  }
  return Math.min(spec.max, Math.max(spec.min, amount))
}

/** An effect's amount at a moment, animated or not. */
export function effectAmountAt(effect: Effect, offsetMicros: number): number {
  return clampEffectAmount(
    effect.kind,
    valueAt(effect.keyframes ?? [], offsetMicros, effect.amount),
  )
}

/**
 * The effects of a segment as one canvas filter string, or 'none'.
 *
 * A segment with no effects, and one whose effects all sit at neutral, both
 * come out as 'none' - so adding an effect and leaving it alone cannot change
 * a single pixel, and the golden-frame comparison stays meaningful.
 */
export function filterFor(
  effects: readonly Effect[] | undefined,
  offsetMicros: number,
): string {
  if (!effects || effects.length === 0) return 'none'

  const parts: string[] = []
  for (const effect of effects) {
    const spec = EFFECT_KINDS[effect.kind]
    if (!spec) continue

    const amount = effectAmountAt(effect, offsetMicros)
    if (amount === spec.neutral) continue

    parts.push(`${effect.kind}(${round(amount)}${spec.unit})`)
  }

  return parts.length > 0 ? parts.join(' ') : 'none'
}

/** Trims float noise out of a filter string so it stays stable and readable. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Whether one property of a segment is animated. */
export function isPropertyAnimated(
  segment: Segment,
  property: AnimatableProperty,
): boolean {
  return (segment.keyframes?.[property]?.length ?? 0) > 0
}

/** Whether a property has a keyframe at exactly this offset from the head. */
export function hasKeyframeAt(
  segment: Segment,
  property: AnimatableProperty,
  offsetMicros: number,
): boolean {
  return (segment.keyframes?.[property] ?? []).some(
    (keyframe) => keyframe.offsetMicros === offsetMicros,
  )
}

/** Whether a segment is animated at all. */
export function isAnimated(segment: Segment): boolean {
  const keyframes = segment.keyframes
  if (!keyframes) return false
  return ANIMATABLE_PROPERTIES.some(
    (property) => (keyframes[property]?.length ?? 0) > 0,
  )
}

/**
 * Whether a segment covers the composition completely and opaquely, so
 * anything under it is hidden.
 *
 * Only a video segment can, and only an untransformed one: the moment it is
 * scaled, moved or faded, what is beneath shows through and has to be drawn.
 * A source that letterboxes leaves bars, which are part of the composition
 * rather than a hole - but they are black, and so is what a hidden row would
 * be drawn onto, so an occlusion test that ignores them would be wrong. Hence
 * the size check.
 */
export function occludesEverything(
  segment: Segment,
  composition: Composition,
  sources: Record<string, Source>,
  timelineMicros: number,
): boolean {
  const content = videoContent(segment)
  if (!content) return false

  const transform = transformAt(segment, timelineMicros)
  if (transform.opacity < 1 || transform.scale < 1) return false
  if (transform.x !== 0 || transform.y !== 0) return false

  const source = sources[content.sourceId]
  if (!source) return false

  // Same aspect ratio means no letterbox bars, so the picture fills the frame.
  return (
    source.width * composition.height === source.height * composition.width
  )
}

/** Narrows a segment to a video one, or undefined if it is text. */
export function videoContent(segment: Segment): VideoContent | undefined {
  return segment.content.kind === 'video' ? segment.content : undefined
}

/** Narrows a segment to a text one, or undefined if it is video. */
export function textContent(segment: Segment): TextContent | undefined {
  return segment.content.kind === 'text' ? segment.content : undefined
}

/** Every segment in the project, with the track it sits on. Bottom track first. */
export function allSegments(
  project: Project,
): { track: Track; segment: Segment }[] {
  return project.tracks.flatMap((track) =>
    track.segments.map((segment) => ({ track, segment })),
  )
}

/** Finds a segment anywhere in the project. */
export function findSegment(
  project: Project,
  segmentId: string,
): { track: Track; segment: Segment; index: number } | undefined {
  for (const track of project.tracks) {
    const index = track.segments.findIndex(
      (segment) => segment.id === segmentId,
    )
    if (index >= 0) {
      return { track, segment: track.segments[index]!, index }
    }
  }
  return undefined
}

/** The track a segment sits on, or undefined if there is no such segment. */
export function trackOf(project: Project, segmentId: string): Track | undefined {
  return findSegment(project, segmentId)?.track
}
