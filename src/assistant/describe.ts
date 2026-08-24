/**
 * What the model is told about the project.
 *
 * The timeline is plain JSON, so it COULD be handed over whole - but most of it
 * is noise to a reader deciding what to edit, and every token of it is paid for
 * on each turn. This is the outline instead: what exists, what it is called,
 * where it sits, and which of the optional things are set.
 *
 * Times are in SECONDS here, and that is deliberate: this is the one boundary,
 * along with the tool arguments in `tools.ts`, where the application speaks
 * anything but integer microseconds. A model emits 4.5 far more reliably than
 * it emits 4500000. Nothing derived from these numbers travels back into the
 * app - the tool boundary converts before anything else sees it.
 */

import { microsToSeconds } from '../playback'
import { timelineDuration } from '../timeline/operations'
import {
  segmentDuration,
  segmentEndMicros,
  segmentLabel,
  segmentRate,
  sourceHasVideo,
  type Project,
  type Segment,
} from '../timeline/types'

/** Three decimals is a millisecond, which is finer than anyone edits by hand. */
function seconds(micros: number): number {
  return Math.round(microsToSeconds(micros) * 1000) / 1000
}

/** The same rounding, for values that arrive already in seconds. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

export type SegmentOutline = {
  id: string
  label: string
  kind: 'video' | 'text' | 'audio'
  startSeconds: number
  endSeconds: number
  durationSeconds: number
  sourceId?: string
  sourceInSeconds?: number
  sourceOutSeconds?: number
  rate?: number
  text?: string
  blendMode?: string
  transitionIn?: { kind: string; durationSeconds: number }
  effects?: { id: string; kind: string; amount: number }[]
  properties?: Record<string, number>
  animated?: string[]
  masked?: true
  chromaKeyed?: true
}

/** What a source says, trimmed to what an agent can act on. */
/**
 * One word and when it was said, as [start, end, word] in SOURCE seconds.
 *
 * A tuple rather than an object because there are thousands of these and every
 * repeated key is paid for in the request. The shape is stated in the agent's
 * instructions instead.
 */
export type WordTiming = [number, number, string]

/** A stretch where nobody is speaking, as [start, end] in SOURCE seconds. */
export type PauseSpan = [number, number]

export type SourceScript = {
  sourceId: string
  language: string
  lines: {
    startSeconds: number
    endSeconds: number
    text: string
    /**
     * When each word was said. Absent on a long file - see `wordsOmitted` - and
     * absent for a line the transcriber gave no word timings for.
     */
    words?: WordTiming[]
    /**
     * Set when the transcriber was markedly unsure of this line - which is what
     * mumbling, an aside, and a line read to oneself all look like.
     */
    unclear?: true
    /** Set when this line is markedly quieter than the rest of the take. */
    quiet?: true
    /**
     * The index of an earlier line this one closely repeats, when there is one.
     * The later of a pair is almost always the take worth keeping.
     */
    repeatOf?: number
  }[]
  /**
   * Where nobody is speaking, measured from the waveform rather than the words.
   *
   * A cut belongs in one of these. A boundary taken from a transcript lands
   * where a word BEGINS, which is a moment before the sound and a moment after
   * the breath before it, and cutting exactly there clips both ends.
   */
  pauses?: PauseSpan[]
  /**
   * Set when the file was too long to send every word, so the agent knows its
   * finest available boundary is a whole line rather than assuming it has one.
   */
  wordsOmitted?: true
}

/**
 * How much speech is worth sending word by word.
 *
 * Word timings are what let a cut land on a sentence instead of somewhere near
 * it, and on anything of ordinary length they are cheap. A long interview is a
 * different thing: five thousand words is a large request every time the agent
 * is asked anything at all, and a person editing one should not pay for that
 * precision on every turn without asking for it. Past this the lines still go,
 * and `wordsOmitted` says why they are alone.
 */
export const WORD_TIMING_LIMIT_SECONDS = 600
export const WORD_TIMING_LIMIT_WORDS = 3_000

/**
 * Where "unsure" and "quiet" begin.
 *
 * Sent as FLAGS rather than as numbers, and only when they are true. A clarity
 * of 0.94 on every ordinary line is noise in the request and noise in the
 * reading; what is worth saying is that this one is 0.41. The thresholds are
 * deliberately not tight - a flag that fires on half the lines says nothing.
 */
export const UNCLEAR_BELOW = 0.6
export const QUIET_BELOW = 0.6

/**
 * What a source LOOKS like, in SOURCE seconds.
 *
 * The counterpart to a script, and separate from it because they answer
 * different questions and are measured by different means: the words come from
 * a local transcriber, the shots from frames sent away to be described.
 */
export type SourceVisuals = {
  sourceId: string
  shots: { startSeconds: number; endSeconds: number; text: string }[]
  /** Set when only the first part of a long film was looked at. */
  truncatedAfterSeconds?: number
}

export type ProjectOutline = {
  composition: { width: number; height: number }
  durationSeconds: number
  playheadSeconds?: number
  selectedSegmentId?: string
  sources: {
    id: string
    name: string
    durationSeconds: number
    hasPicture: boolean
  }[]
  /**
   * What has been transcribed, in SOURCE seconds.
   *
   * Present only for files somebody has asked about - transcribing is slow and
   * deliberate. Without this an agent has no way to know what is said, and is
   * told in its instructions not to guess.
   */
  scripts?: SourceScript[]
  /**
   * What has been LOOKED at, in SOURCE seconds.
   *
   * Present only for files somebody asked about, exactly like the scripts:
   * looking costs money and sends pictures away, so it never happens by itself.
   */
  visuals?: SourceVisuals[]
  /** Bottom of the stack first, exactly as the project stores them. */
  tracks: {
    id: string
    kind: 'video' | 'text' | 'audio'
    segments: SegmentOutline[]
  }[]
}

function describeSegment(project: Project, segment: Segment): SegmentOutline {
  const content = segment.content

  const outline: SegmentOutline = {
    id: segment.id,
    label: segmentLabel(project, segment),
    kind: content.kind,
    startSeconds: seconds(segment.timelineStartMicros),
    endSeconds: seconds(segmentEndMicros(segment)),
    durationSeconds: seconds(segmentDuration(segment)),
  }

  if (content.kind === 'text') {
    outline.text = content.content
  } else {
    outline.sourceId = content.sourceId
    outline.sourceInSeconds = seconds(content.sourceInMicros)
    outline.sourceOutSeconds = seconds(content.sourceOutMicros)

    const rate = segmentRate(segment)
    if (rate !== 1) outline.rate = rate
  }

  if (segment.blendMode) outline.blendMode = segment.blendMode
  if (segment.transitionIn) {
    outline.transitionIn = {
      kind: segment.transitionIn.kind,
      durationSeconds: seconds(segment.transitionIn.durationMicros),
    }
  }
  if (segment.effects?.length) {
    outline.effects = segment.effects.map((effect) => ({
      id: effect.id,
      kind: effect.kind,
      amount: effect.amount,
    }))
  }
  if (segment.properties && Object.keys(segment.properties).length > 0) {
    outline.properties = { ...segment.properties }
  }

  // Which properties are animated matters - a fixed value the model overwrites
  // would silently do nothing where a curve is what is being read.
  const animated = Object.entries(segment.keyframes ?? {})
    .filter(([, frames]) => (frames?.length ?? 0) > 0)
    .map(([property]) => property)
  if (animated.length > 0) outline.animated = animated

  if (segment.mask) outline.masked = true
  if (segment.chromaKey) outline.chromaKeyed = true

  return outline
}

/**
 * What the editor knows that the project does not.
 *
 * Defined once, here, and imported by everything that passes it along. It used
 * to be written out in the component, the bridge and the agent, and a field
 * added to the outline had to be added to three copies of a type before it
 * could reach one.
 *
 * Everything in it is DERIVED FROM MEDIA or from what is on screen - never
 * authored - which is exactly why none of it is in the project and all of it
 * has to be handed in.
 */
export type ProjectView = {
  playheadMicros?: number
  selectedSegmentId?: string | null
  /** Transcripts by source id, for the sources that have one. */
  scripts?: Record<
    string,
    {
      language: string
      duration?: number
      segments: {
        start: number
        end: number
        text: string
        words?: { start: number; end: number; word: string }[]
      }[]
    }
  >
  /**
   * Where nobody is speaking, by source id, in SOURCE microseconds.
   *
   * Derived from the peaks rather than from the words, and passed in for the
   * same reason the transcripts are: both are measured from media, so neither
   * is part of the project and neither can be read from it here.
   */
  pauses?: Record<string, { startMicros: number; endMicros: number }[]>
  /**
   * What the words alone do not say, line by line: how clearly and how loudly
   * each was said, and whether it repeats an earlier one. All arithmetic - see
   * `signals.ts` - so the agent reads them rather than guessing at them.
   */
  signals?: Record<
    string,
    { clarity?: number; loudness?: number; repeatOf?: number }[]
  >
  /** What each looked-at source shows, by source id, in SOURCE seconds. */
  visuals?: Record<
    string,
    {
      shots: { startSeconds: number; endSeconds: number; text: string }[]
      truncatedAfterSeconds?: number
    }
  >
}

export function describeProject(
  project: Project,
  view?: ProjectView,
): ProjectOutline {
  const outline: ProjectOutline = {
    composition: { ...project.composition },
    durationSeconds: seconds(timelineDuration(project)),
    sources: Object.values(project.sources).map((source) => ({
      id: source.id,
      name: source.name,
      durationSeconds: seconds(source.durationMicros),
      hasPicture: sourceHasVideo(source),
    })),
    tracks: project.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      segments: track.segments.map((segment) =>
        describeSegment(project, segment),
      ),
    })),
  }

  if (view?.playheadMicros !== undefined) {
    outline.playheadSeconds = seconds(view.playheadMicros)
  }
  if (view?.selectedSegmentId) {
    outline.selectedSegmentId = view.selectedSegmentId
  }

  const scripts = Object.entries(view?.scripts ?? {})
    .filter(([, script]) => script.segments.length > 0)
    .map(([sourceId, script]): SourceScript => {
      const spoken = script.segments.reduce(
        (total, line) => total + (line.words?.length ?? 0),
        0,
      )
      const withWords =
        spoken > 0 &&
        spoken <= WORD_TIMING_LIMIT_WORDS &&
        (script.duration ?? 0) <= WORD_TIMING_LIMIT_SECONDS

      const out: SourceScript = {
        sourceId,
        language: script.language,
        lines: script.segments.map((line, index) => {
          const signals = view?.signals?.[sourceId]?.[index]
          return {
            startSeconds: round(line.start),
            endSeconds: round(line.end),
            text: line.text,
            ...(withWords && line.words && line.words.length > 0
              ? {
                  words: line.words.map(
                    (word): WordTiming => [
                      round(word.start),
                      round(word.end),
                      word.word.trim(),
                    ],
                  ),
                }
              : {}),
            ...(signals?.clarity !== undefined && signals.clarity < UNCLEAR_BELOW
              ? { unclear: true as const }
              : {}),
            ...(signals?.loudness !== undefined && signals.loudness < QUIET_BELOW
              ? { quiet: true as const }
              : {}),
            ...(signals?.repeatOf !== undefined
              ? { repeatOf: signals.repeatOf }
              : {}),
          }
        }),
      }

      if (!withWords && spoken > 0) out.wordsOmitted = true

      const pauses = view?.pauses?.[sourceId] ?? []
      if (pauses.length > 0) {
        out.pauses = pauses.map((span): PauseSpan => [
          seconds(span.startMicros),
          seconds(span.endMicros),
        ])
      }

      return out
    })
  if (scripts.length > 0) outline.scripts = scripts

  const visuals = Object.entries(view?.visuals ?? {})
    .filter(([, seen]) => seen.shots.length > 0)
    .map(([sourceId, seen]): SourceVisuals => ({
      sourceId,
      shots: seen.shots.map((shot) => ({
        startSeconds: round(shot.startSeconds),
        endSeconds: round(shot.endSeconds),
        text: shot.text,
      })),
      ...(seen.truncatedAfterSeconds !== undefined
        ? { truncatedAfterSeconds: round(seen.truncatedAfterSeconds) }
        : {}),
    }))
  if (visuals.length > 0) outline.visuals = visuals

  return outline
}
