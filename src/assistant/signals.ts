/**
 * What the words alone do not say.
 *
 * Three things an editor uses constantly and a transcript cannot carry: how
 * CLEARLY something was said, how LOUDLY, and whether it had already been said
 * a moment before. Between them they are most of what separates a rehearsal
 * from a take - somebody muttering a line to themselves before delivering it is
 * quieter, less distinct, and about to repeat themselves.
 *
 * All three are arithmetic, and that is the point. Asked to spot a rehearsal
 * from text alone a model is guessing; handed "this line is half as loud as the
 * rest, was barely intelligible, and is repeated four seconds later" it is
 * reading. The same reasoning `silence.ts` is built on: compute what can be
 * computed, and spend the model on what cannot.
 *
 * Times are SOURCE seconds throughout, like everything else measured from a
 * file rather than authored on a timeline.
 */

export type Line = {
  start: number
  end: number
  text: string
  words?: { start: number; end: number; word: string; probability: number }[]
}

export type LineSignals = {
  /** Mean word confidence, 0 to 1. Absent when the line carries no words. */
  clarity?: number
  /**
   * Loudness against the median line, where 1 is typical. Absent when the
   * waveform has not been measured.
   */
  loudness?: number
  /** The index of an earlier line this one closely repeats. */
  repeatOf?: number
}

/** How sure the transcriber was of a line, on average. */
export function clarityOf(line: Line): number | undefined {
  const words = line.words ?? []
  if (words.length === 0) return undefined

  const total = words.reduce((sum, word) => sum + word.probability, 0)
  return round(total / words.length)
}

/**
 * How loud each line is against the median line.
 *
 * Relative rather than absolute, because absolute level says more about the
 * microphone and the room than about the delivery. One is typical; a half is
 * markedly quieter than the rest of the take, which is what an aside sounds
 * like.
 */
export function loudnessOfLines(
  lines: Line[],
  peaks: Float32Array,
  bucketsPerSecond: number,
): (number | undefined)[] {
  if (peaks.length === 0 || bucketsPerSecond <= 0) {
    return lines.map(() => undefined)
  }

  const levels = lines.map((line) => {
    const from = Math.max(0, Math.floor(line.start * bucketsPerSecond))
    const to = Math.min(peaks.length, Math.ceil(line.end * bucketsPerSecond))
    if (to <= from) return undefined

    let total = 0
    for (let at = from; at < to; at++) total += peaks[at] ?? 0
    return total / (to - from)
  })

  const measured = levels.filter((level): level is number => level !== undefined)
  const middle = median(measured)
  if (middle === undefined || middle <= 0) return lines.map(() => undefined)

  return levels.map((level) =>
    level === undefined ? undefined : round(level / middle),
  )
}

/** How close together two lines have to be for one to be a rehearsal of the other. */
export const REPEAT_WINDOW_SECONDS = 20

/** How much of the shorter line has to appear in the longer one. */
export const REPEAT_OVERLAP = 0.75

/**
 * Which lines repeat an earlier one.
 *
 * Measured as how much of the SHORTER line appears in the longer, rather than
 * as how alike the two are overall: a rehearsal is very often an abandoned
 * prefix of the real take - "so the thing about it is" then "so the thing about
 * it is that we built it in a week" - and a symmetric comparison scores that
 * pair as barely related.
 *
 * Only within a window, because somebody returning to a theme ten minutes later
 * is making a point, not fluffing a line.
 */
export function findRepeats(lines: Line[]): (number | undefined)[] {
  const tokens = lines.map((line) => new Set(wordsIn(line.text)))

  return lines.map((line, index) => {
    for (let earlier = index - 1; earlier >= 0; earlier--) {
      if (line.start - lines[earlier]!.start > REPEAT_WINDOW_SECONDS) break

      const a = tokens[earlier]!
      const b = tokens[index]!
      if (a.size === 0 || b.size === 0) continue

      let shared = 0
      for (const token of b) if (a.has(token)) shared++

      if (shared / Math.min(a.size, b.size) >= REPEAT_OVERLAP) return earlier
    }
    return undefined
  })
}

/** Everything the three of them say about a set of lines, line by line. */
export function signalsFor(
  lines: Line[],
  peaks?: { peaks: Float32Array; bucketsPerSecond: number },
): LineSignals[] {
  const loudness = peaks
    ? loudnessOfLines(lines, peaks.peaks, peaks.bucketsPerSecond)
    : lines.map(() => undefined)
  const repeats = findRepeats(lines)

  return lines.map((line, index) => {
    const signals: LineSignals = {}
    const clarity = clarityOf(line)
    if (clarity !== undefined) signals.clarity = clarity
    if (loudness[index] !== undefined) signals.loudness = loudness[index]
    if (repeats[index] !== undefined) signals.repeatOf = repeats[index]
    return signals
  })
}

/** Words, lowercased and stripped of what punctuation does to them. */
function wordsIn(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[.,!?;:'"()[\]{}‘’“”…।]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 0)
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
