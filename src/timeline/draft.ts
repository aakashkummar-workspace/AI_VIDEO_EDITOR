/**
 * The saved project file.
 *
 * The timeline state is plain JSON by rule, so writing it out is nearly free.
 * The work is on the way back IN: a draft is a file off someone's disk, so
 * nothing in it is trusted. Everything below is rebuilt field by field into a
 * fresh object rather than cast, which drops anything unrecognised and makes a
 * malformed draft fail with a sentence rather than a broken timeline three
 * edits later.
 *
 * What is deliberately NOT in here is the media. A draft names its sources and
 * remembers their shape, but a File cannot be serialised and a path would be
 * meaningless to a browser. Opening a draft therefore leaves its sources
 * unlinked until the files are handed back - which is exactly what CapCut does
 * when it says the media is offline.
 */

import {
  ANIMATABLE_PROPERTIES,
  EFFECT_KINDS,
  EXPORT_QUALITIES,
  MIN_SEGMENT_MICROS,
  TRANSITION_KINDS,
  type AnimatableProperty,
  type Effect,
  type EffectKind,
  type ExportSettings,
  type Keyframe,
  type Keyframes,
  type Project,
  type Rotation,
  type Segment,
  type SegmentContent,
  type Source,
  type Track,
  type TrackKind,
  type Transition,
  type TransitionKind,
} from './types'

/**
 * Bumped only when an old draft would otherwise be read wrongly. A reader that
 * meets a version it does not know refuses rather than guessing.
 */
export const DRAFT_VERSION = 1

export type Draft = {
  kind: 'video-editor-draft'
  version: number
  project: Project
}

export function toDraft(project: Project): Draft {
  return {
    kind: 'video-editor-draft',
    version: DRAFT_VERSION,
    // Round-tripped rather than referenced, so a draft can never share
    // structure with the live project.
    project: JSON.parse(JSON.stringify(project)) as Project,
  }
}

/** Serialises a project as the text that goes in the file. */
export function serializeDraft(project: Project): string {
  return `${JSON.stringify(toDraft(project), null, 2)}\n`
}

class DraftError extends Error {}

function fail(message: string): never {
  throw new DraftError(`This draft could not be read: ${message}`)
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${what} is missing or is not an object.`)
  }
  return value as Record<string, unknown>
}

function array(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) fail(`${what} is missing or is not a list.`)
  return value
}

function str(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${what} is missing or is not text.`)
  }
  return value
}

function num(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${what} is missing or is not a number.`)
  }
  return value
}

function micros(value: unknown, what: string): number {
  const found = num(value, what)
  if (!Number.isInteger(found)) {
    fail(`${what} must be a whole number of microseconds.`)
  }
  return found
}

function rotation(value: unknown, what: string): Rotation {
  const found = num(value, what)
  if (found !== 0 && found !== 90 && found !== 180 && found !== 270) {
    fail(`${what} must be 0, 90, 180 or 270.`)
  }
  return found
}

function parseExportSettings(value: unknown): ExportSettings | undefined {
  if (value === undefined) return undefined

  const raw = record(value, 'the export settings')

  let heightPx: number | null = null
  if (raw.heightPx !== null && raw.heightPx !== undefined) {
    heightPx = num(raw.heightPx, 'the export height')
    if (!Number.isInteger(heightPx) || heightPx <= 0) {
      fail('the export height must be a positive whole number of pixels.')
    }
  }

  const quality = str(raw.quality, 'the export quality')
  if (!EXPORT_QUALITIES.includes(quality as ExportSettings['quality'])) {
    fail(`the export quality is one this version does not know (${quality}).`)
  }

  return { heightPx, quality: quality as ExportSettings['quality'] }
}

function parseSource(value: unknown, id: string): Source {
  const raw = record(value, `source ${id}`)
  const durationMicros = micros(raw.durationMicros, `source ${id} duration`)
  if (durationMicros <= 0) fail(`source ${id} has no duration.`)

  return {
    id,
    name: str(raw.name, `source ${id} name`),
    durationMicros,
    width: num(raw.width, `source ${id} width`),
    height: num(raw.height, `source ${id} height`),
    rotation: rotation(raw.rotation, `source ${id} rotation`),
  }
}

function parseKeyframes(value: unknown, what: string): Keyframe[] {
  const parsed = array(value, what).map((entry, index) => {
    const raw = record(entry, `${what}[${index}]`)
    const offsetMicros = micros(raw.offsetMicros, `${what}[${index}] offset`)
    if (offsetMicros < 0) fail(`${what}[${index}] sits before its segment.`)

    return { offsetMicros, value: num(raw.value, `${what}[${index}] value`) }
  })

  return parsed.sort((a, b) => a.offsetMicros - b.offsetMicros)
}

function parseProperties(
  value: unknown,
  what: string,
): Partial<Record<AnimatableProperty, number>> | undefined {
  if (value === undefined) return undefined

  const raw = record(value, what)
  const properties: Partial<Record<AnimatableProperty, number>> = {}

  for (const property of ANIMATABLE_PROPERTIES) {
    if (raw[property] === undefined) continue
    properties[property] = num(raw[property], `${what} ${property}`)
  }

  return Object.keys(properties).length > 0 ? properties : undefined
}

function parseSegmentKeyframes(
  value: unknown,
  what: string,
): Keyframes | undefined {
  if (value === undefined) return undefined

  const raw = record(value, what)
  const keyframes: Keyframes = {}

  for (const property of ANIMATABLE_PROPERTIES) {
    if (raw[property] === undefined) continue
    const curve = parseKeyframes(raw[property], `${what} ${property}`)
    if (curve.length > 0) keyframes[property as AnimatableProperty] = curve
  }

  return Object.keys(keyframes).length > 0 ? keyframes : undefined
}

function parseEffects(value: unknown, what: string): Effect[] | undefined {
  if (value === undefined) return undefined

  const effects = array(value, what).map((entry, index) => {
    const raw = record(entry, `${what}[${index}]`)
    const kind = str(raw.kind, `${what}[${index}] kind`)
    if (!(kind in EFFECT_KINDS)) {
      fail(`${what}[${index}] is an effect this version does not know (${kind}).`)
    }

    const effect: Effect = {
      id: str(raw.id, `${what}[${index}] id`),
      kind: kind as EffectKind,
      amount: num(raw.amount, `${what}[${index}] amount`),
    }

    if (raw.keyframes !== undefined) {
      const curve = parseKeyframes(raw.keyframes, `${what}[${index}] keyframes`)
      if (curve.length > 0) effect.keyframes = curve
    }

    return effect
  })

  return effects.length > 0 ? effects : undefined
}

function parseTransition(
  value: unknown,
  what: string,
): Transition | undefined {
  if (value === undefined) return undefined

  const raw = record(value, what)
  const kind = str(raw.kind, `${what} kind`)
  if (!TRANSITION_KINDS.includes(kind as TransitionKind)) {
    fail(`${what} is a transition this version does not know (${kind}).`)
  }

  const durationMicros = micros(raw.durationMicros, `${what} duration`)
  if (durationMicros < MIN_SEGMENT_MICROS) {
    fail(`${what} has no duration.`)
  }

  return { kind: kind as TransitionKind, durationMicros }
}

function parseContent(value: unknown, what: string): SegmentContent {
  const raw = record(value, what)
  const kind = str(raw.kind, `${what} kind`)

  if (kind === 'video') {
    return {
      kind: 'video',
      sourceId: str(raw.sourceId, `${what} sourceId`),
      sourceInMicros: micros(raw.sourceInMicros, `${what} in-point`),
      sourceOutMicros: micros(raw.sourceOutMicros, `${what} out-point`),
    }
  }

  if (kind === 'audio') {
    return {
      kind: 'audio',
      sourceId: str(raw.sourceId, `${what} sourceId`),
      sourceInMicros: micros(raw.sourceInMicros, `${what} in-point`),
      sourceOutMicros: micros(raw.sourceOutMicros, `${what} out-point`),
    }
  }

  if (kind === 'text') {
    return {
      kind: 'text',
      content: typeof raw.content === 'string' ? raw.content : '',
      x: num(raw.x, `${what} x`),
      y: num(raw.y, `${what} y`),
      sizePx: num(raw.sizePx, `${what} size`),
      color: str(raw.color, `${what} colour`),
      durationMicros: micros(raw.durationMicros, `${what} duration`),
    }
  }

  return fail(`${what} is a kind of segment this version does not know (${kind}).`)
}

function parseSegment(value: unknown, what: string): Segment {
  const raw = record(value, what)
  const timelineStartMicros = micros(raw.timelineStartMicros, `${what} start`)
  if (timelineStartMicros < 0) fail(`${what} starts before the timeline does.`)

  const segment: Segment = {
    id: str(raw.id, `${what} id`),
    timelineStartMicros,
    content: parseContent(raw.content, `${what} content`),
  }

  const properties = parseProperties(raw.properties, `${what} properties`)
  if (properties) segment.properties = properties

  const keyframes = parseSegmentKeyframes(raw.keyframes, `${what} keyframes`)
  if (keyframes) segment.keyframes = keyframes

  const effects = parseEffects(raw.effects, `${what} effects`)
  if (effects) segment.effects = effects

  const transitionIn = parseTransition(
    raw.transitionIn,
    `${what} transition`,
  )
  if (transitionIn) segment.transitionIn = transitionIn

  return segment
}

function parseTrack(value: unknown, index: number): Track {
  const raw = record(value, `track ${index}`)
  const kind = str(raw.kind, `track ${index} kind`)
  if (kind !== 'video' && kind !== 'text' && kind !== 'audio') {
    fail(`track ${index} is a kind of row this version does not know (${kind}).`)
  }

  const id = str(raw.id, `track ${index} id`)
  const segments = array(raw.segments, `track ${id} segments`).map(
    (entry, at) => parseSegment(entry, `segment ${at} on track ${id}`),
  )

  segments.sort((a, b) => a.timelineStartMicros - b.timelineStartMicros)

  return { id, kind: kind as TrackKind, segments }
}

/**
 * Checks the things the operations guarantee while a project is being edited,
 * which a hand-edited or truncated file could break.
 */
function assertConsistent(project: Project): void {
  const seenTracks = new Set<string>()
  const seenSegments = new Set<string>()

  for (const track of project.tracks) {
    if (seenTracks.has(track.id)) fail(`two rows share the id ${track.id}.`)
    seenTracks.add(track.id)

    let previousEnd = -1
    for (const segment of track.segments) {
      if (seenSegments.has(segment.id)) {
        fail(`two segments share the id ${segment.id}.`)
      }
      seenSegments.add(segment.id)

      const content = segment.content
      if (content.kind !== track.kind) {
        fail(`segment ${segment.id} is on a row that cannot hold it.`)
      }

      const duration =
        content.kind === 'text'
          ? content.durationMicros
          : content.sourceOutMicros - content.sourceInMicros
      if (duration < MIN_SEGMENT_MICROS) {
        fail(`segment ${segment.id} has no duration.`)
      }

      if (content.kind !== 'text') {
        if (!project.sources[content.sourceId]) {
          fail(
            `segment ${segment.id} points at a source the draft does not list` +
              ` (${content.sourceId}).`,
          )
        }
        if (content.sourceInMicros < 0) {
          fail(`segment ${segment.id} starts before its source does.`)
        }
      }

      // Only a packed row: a text row is allowed to stack captions. A
      // transition is the one overlap allowed, and only by its own length.
      if (track.kind !== 'text') {
        const allowed = segment.transitionIn?.durationMicros ?? 0
        if (segment.timelineStartMicros < previousEnd - allowed) {
          fail(`segments overlap on row ${track.id}.`)
        }
        if (allowed > 0 && previousEnd < 0) {
          fail(
            `segment ${segment.id} blends from something that is not there.`,
          )
        }
        previousEnd = segment.timelineStartMicros + duration
      }
    }
  }
}

/**
 * Rebuilds a project from the contents of a draft file.
 *
 * Throws with a readable message rather than returning a half-built project:
 * an editor that opens a broken draft into a broken timeline is worse than one
 * that says what is wrong with the file.
 */
export function parseDraft(value: unknown): Project {
  const raw = record(value, 'the draft')

  if (raw.kind !== 'video-editor-draft') {
    fail('it is not a project file.')
  }

  const version = num(raw.version, 'the draft version')
  if (version > DRAFT_VERSION) {
    fail(
      `it was written by a newer version of the editor (${version}, this one` +
        ` reads ${DRAFT_VERSION}).`,
    )
  }

  const project = record(raw.project, 'the project')
  const composition = record(project.composition, 'the composition')
  const width = num(composition.width, 'the composition width')
  const height = num(composition.height, 'the composition height')
  if (width <= 0 || height <= 0 || !Number.isInteger(width) || !Number.isInteger(height)) {
    fail('the composition has to be a whole number of pixels across and down.')
  }

  const sourcesRaw = record(project.sources, 'the sources')
  const sources: Record<string, Source> = {}
  for (const [id, entry] of Object.entries(sourcesRaw)) {
    sources[id] = parseSource(entry, id)
  }

  const tracks = array(project.tracks, 'the tracks').map(parseTrack)

  const rebuilt: Project = { composition: { width, height }, sources, tracks }

  const exportSettings = parseExportSettings(project.exportSettings)
  if (exportSettings) rebuilt.exportSettings = exportSettings

  assertConsistent(rebuilt)
  return rebuilt
}

/** Parses the text of a draft file. */
export function parseDraftText(text: string): Project {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    fail('it is not valid JSON.')
  }
  return parseDraft(value)
}

/** Whether an error came from reading a draft, so it can be shown as-is. */
export function isDraftError(error: unknown): boolean {
  return error instanceof DraftError
}

/** What a saved draft downloads as. */
export function draftFileName(project: Project): string {
  const first = Object.values(project.sources)[0]
  const base = (first?.name ?? 'timeline').replace(/\.[^.]*$/, '').trim()
  return base.length > 0 ? `${base}.draft.json` : 'timeline.draft.json'
}
