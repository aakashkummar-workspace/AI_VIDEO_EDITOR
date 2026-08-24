/**
 * Finding the parts worth keeping.
 *
 * This is arithmetic on the waveform the worker already measures, and there is
 * deliberately no model in it: where somebody stopped talking is a question
 * about loudness, it has one right answer, and a language model would be slower,
 * cost money and disagree with itself between runs. What a model would be for is
 * deciding which WORDS to cut, and that needs a transcript this project has no
 * way to produce.
 *
 * Everything here is in SOURCE time, because that is what peaks are measured in
 * - a segment's own range is a window onto them, and trimming a block re-slices
 * the same measurements rather than asking for new ones.
 */

/** A stretch of source time. Half-open: start is in, end is out. */
export type Span = { startMicros: number; endMicros: number }

export type SilenceOptions = {
  /**
   * Peaks at or below this count as quiet, from 0 to 1.
   *
   * Peaks are the loudest sample in each bucket, not an average, so this sits
   * lower than a level meter would suggest: room tone with a fridge in it still
   * spikes well above 0.02.
   */
  threshold: number
  /**
   * How long quiet has to last before it is worth cutting.
   *
   * The gap between two words is quiet too. Cutting those would run the speech
   * together and sound worse than the pauses did, so only a stretch longer than
   * a natural breath counts.
   */
  minSilenceMicros: number
  /**
   * Kept either side of every stretch of speech.
   *
   * A cut placed exactly where the level crosses the threshold clips the start
   * of the word, because a consonant rises over several buckets. This is the
   * room the attack needs.
   */
  padMicros: number
}

export const DEFAULT_SILENCE_OPTIONS: SilenceOptions = {
  threshold: 0.04,
  minSilenceMicros: 500_000,
  padMicros: 80_000,
}

const MICROS_PER_SECOND = 1_000_000

/**
 * The stretches of `range` worth keeping, in order and never overlapping.
 *
 * An empty result means the whole range is quiet, which the caller has to treat
 * as "nothing to keep" rather than "nothing to do" - they are opposites.
 * A single span covering the range means there was nothing worth cutting.
 *
 * With no peaks - a source nobody has measured yet - the answer is the range
 * itself: not knowing where the silence is must never be mistaken for knowing
 * there is none of it, and this way a caller does nothing rather than the wrong
 * thing.
 */
export function loudSpans(
  peaks: Float32Array,
  bucketsPerSecond: number,
  range: Span,
  options: SilenceOptions = DEFAULT_SILENCE_OPTIONS,
): Span[] {
  const width = range.endMicros - range.startMicros
  if (width <= 0) return []
  if (peaks.length === 0 || bucketsPerSecond <= 0) return [{ ...range }]

  const bucketMicros = MICROS_PER_SECOND / bucketsPerSecond
  const firstBucket = Math.floor(range.startMicros / bucketMicros)
  const lastBucket = Math.ceil(range.endMicros / bucketMicros)

  /* Runs of quiet long enough to be worth cutting, in source time. */
  const gaps: Span[] = []
  let quietFrom: number | null = null

  const closeQuiet = (endMicros: number) => {
    if (quietFrom === null) return
    if (endMicros - quietFrom >= options.minSilenceMicros) {
      gaps.push({ startMicros: quietFrom, endMicros })
    }
    quietFrom = null
  }

  for (let bucket = firstBucket; bucket < lastBucket; bucket++) {
    const from = Math.max(range.startMicros, Math.round(bucket * bucketMicros))
    const to = Math.min(
      range.endMicros,
      Math.round((bucket + 1) * bucketMicros),
    )
    if (to <= from) continue

    // Past the end of what was measured, treat it as quiet rather than as
    // sound: a source is silent after it stops.
    const peak = bucket < peaks.length ? (peaks[bucket] ?? 0) : 0

    if (peak <= options.threshold) {
      if (quietFrom === null) quietFrom = from
    } else {
      closeQuiet(from)
    }
  }
  closeQuiet(range.endMicros)

  // What is left between the gaps is what is kept, grown by the padding - which
  // eats into the gaps rather than into the speech.
  const kept: Span[] = []
  let cursor = range.startMicros

  for (const gap of gaps) {
    if (gap.startMicros > cursor) {
      kept.push({ startMicros: cursor, endMicros: gap.startMicros })
    }
    cursor = gap.endMicros
  }
  if (cursor < range.endMicros) {
    kept.push({ startMicros: cursor, endMicros: range.endMicros })
  }

  return pad(kept, range, options.padMicros)
}

/**
 * Grows each span outwards and merges any that now touch.
 *
 * Merging matters: padding two spans either side of a gap barely longer than the
 * padding would otherwise leave a sliver of silence between them, and a sliver
 * is worse than the gap was.
 */
function pad(spans: Span[], range: Span, padMicros: number): Span[] {
  if (padMicros <= 0) return spans

  const merged: Span[] = []

  for (const span of spans) {
    const grown = {
      startMicros: Math.max(range.startMicros, span.startMicros - padMicros),
      endMicros: Math.min(range.endMicros, span.endMicros + padMicros),
    }

    const previous = merged.at(-1)
    if (previous && grown.startMicros <= previous.endMicros) {
      previous.endMicros = Math.max(previous.endMicros, grown.endMicros)
      continue
    }

    merged.push(grown)
  }

  return merged
}

/** How much of `range` the spans do NOT cover, which is what a trim removes. */
/**
 * The stretches of `range` where nobody is speaking.
 *
 * The exact complement of `loudSpans`, and it has to be derived from it rather
 * than measured again: a pause is defined as what is left over once the padding
 * around speech has been taken, and two functions deciding that separately would
 * eventually disagree about where a word starts.
 *
 * This is what a cut wants. A boundary chosen from a transcript lands where a
 * word begins, which is a fraction before the sound does and a fraction after
 * the breath that preceded it - and cutting there clips both. Landing in one of
 * these is what makes a cut sound deliberate rather than truncated.
 *
 * With no peaks the answer is EMPTY, and that is the honest one: not knowing
 * where the pauses are must never be reported as knowing there are none.
 */
export function quietSpans(
  peaks: Float32Array,
  bucketsPerSecond: number,
  range: Span,
  options: SilenceOptions = DEFAULT_SILENCE_OPTIONS,
): Span[] {
  if (peaks.length === 0 || bucketsPerSecond <= 0) return []

  const loud = loudSpans(peaks, bucketsPerSecond, range, options)
  const quiet: Span[] = []
  let at = range.startMicros

  for (const span of loud) {
    if (span.startMicros > at) {
      quiet.push({ startMicros: at, endMicros: span.startMicros })
    }
    at = span.endMicros
  }
  if (at < range.endMicros) {
    quiet.push({ startMicros: at, endMicros: range.endMicros })
  }

  return quiet
}

export function removedMicros(spans: Span[], range: Span): number {
  const kept = spans.reduce(
    (total, span) => total + (span.endMicros - span.startMicros),
    0,
  )
  return Math.max(0, range.endMicros - range.startMicros - kept)
}
