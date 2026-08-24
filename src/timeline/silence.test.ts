import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SILENCE_OPTIONS,
  loudSpans,
  quietSpans,
  removedMicros,
  type SilenceOptions,
} from './silence'

const SECOND = 1_000_000

/** 50 buckets a second is what the worker measures at. */
const BUCKETS = 50
const BUCKET_MICROS = SECOND / BUCKETS

/**
 * Builds peaks from a description in seconds: 'x' is loud, '.' is quiet, one
 * character per second. Easier to read in a test than an array of 250 numbers.
 */
function peaksFrom(pattern: string, loud = 0.8, quiet = 0.01): Float32Array {
  const out = new Float32Array(pattern.length * BUCKETS)
  for (let second = 0; second < pattern.length; second++) {
    const level = pattern[second] === 'x' ? loud : quiet
    out.fill(level, second * BUCKETS, (second + 1) * BUCKETS)
  }
  return out
}

const NO_PAD: SilenceOptions = { ...DEFAULT_SILENCE_OPTIONS, padMicros: 0 }

function whole(seconds: number) {
  return { startMicros: 0, endMicros: seconds * SECOND }
}

describe('finding what to keep', () => {
  it('keeps everything when nothing is quiet', () => {
    const spans = loudSpans(peaksFrom('xxxx'), BUCKETS, whole(4), NO_PAD)

    expect(spans).toEqual([{ startMicros: 0, endMicros: 4 * SECOND }])
  })

  it('cuts a quiet stretch out of the middle', () => {
    const spans = loudSpans(peaksFrom('x..x'), BUCKETS, whole(4), NO_PAD)

    expect(spans).toEqual([
      { startMicros: 0, endMicros: 1 * SECOND },
      { startMicros: 3 * SECOND, endMicros: 4 * SECOND },
    ])
  })

  it('cuts quiet off both ends', () => {
    const spans = loudSpans(peaksFrom('..xx..'), BUCKETS, whole(6), NO_PAD)

    expect(spans).toEqual([
      { startMicros: 2 * SECOND, endMicros: 4 * SECOND },
    ])
  })

  it('keeps a gap too short to be worth cutting', () => {
    // A pause between two words is quiet too. Cutting those runs the speech
    // together and sounds worse than the pause did.
    const options: SilenceOptions = {
      ...NO_PAD,
      minSilenceMicros: 2 * SECOND,
    }
    const spans = loudSpans(peaksFrom('x.x'), BUCKETS, whole(3), options)

    expect(spans).toEqual([{ startMicros: 0, endMicros: 3 * SECOND }])
  })

  it('keeps nothing when it is all quiet', () => {
    // Empty means "nothing worth keeping", which is the opposite of "nothing to
    // do" - a caller that confused the two would delete the lot or nothing.
    expect(loudSpans(peaksFrom('....'), BUCKETS, whole(4), NO_PAD)).toEqual([])
  })

  it('measures only the range it was given', () => {
    // The peaks belong to the whole source; a segment is a window onto them.
    const spans = loudSpans(
      peaksFrom('..xx..'),
      BUCKETS,
      { startMicros: 3 * SECOND, endMicros: 6 * SECOND },
      NO_PAD,
    )

    expect(spans).toEqual([
      { startMicros: 3 * SECOND, endMicros: 4 * SECOND },
    ])
  })
})

describe('the padding', () => {
  it('leaves room for the start of a word', () => {
    const options: SilenceOptions = { ...NO_PAD, padMicros: 100_000 }
    const spans = loudSpans(peaksFrom('..xx..'), BUCKETS, whole(6), options)

    expect(spans).toEqual([
      { startMicros: 2 * SECOND - 100_000, endMicros: 4 * SECOND + 100_000 },
    ])
  })

  it('never reaches outside the range', () => {
    const options: SilenceOptions = { ...NO_PAD, padMicros: 5 * SECOND }
    const spans = loudSpans(peaksFrom('.x.'), BUCKETS, whole(3), options)

    expect(spans).toEqual([{ startMicros: 0, endMicros: 3 * SECOND }])
  })

  it('merges spans the padding has closed the gap between', () => {
    // Otherwise a sliver of silence is left between them, which is worse than
    // the gap was.
    const options: SilenceOptions = {
      ...NO_PAD,
      minSilenceMicros: SECOND,
      padMicros: 600_000,
    }
    const spans = loudSpans(peaksFrom('x.x'), BUCKETS, whole(3), options)

    expect(spans).toHaveLength(1)
    expect(spans[0]).toEqual({ startMicros: 0, endMicros: 3 * SECOND })
  })
})

describe('what it refuses to guess', () => {
  it('keeps the whole range when the source has not been measured', () => {
    // Not knowing where the silence is must never read as knowing there is
    // none: this way a caller does nothing rather than the wrong thing.
    const spans = loudSpans(new Float32Array(0), BUCKETS, whole(4))

    expect(spans).toEqual([{ startMicros: 0, endMicros: 4 * SECOND }])
  })

  it('treats time past the measurements as quiet', () => {
    // A source is silent after it stops.
    const spans = loudSpans(peaksFrom('xx'), BUCKETS, whole(6), NO_PAD)

    expect(spans).toEqual([{ startMicros: 0, endMicros: 2 * SECOND }])
  })

  it('has nothing to say about an empty range', () => {
    expect(
      loudSpans(peaksFrom('xxxx'), BUCKETS, {
        startMicros: SECOND,
        endMicros: SECOND,
      }),
    ).toEqual([])
  })

  it('survives a bucket rate of zero rather than dividing by it', () => {
    expect(loudSpans(peaksFrom('xxxx'), 0, whole(4))).toEqual([
      { startMicros: 0, endMicros: 4 * SECOND },
    ])
  })
})

describe('the threshold', () => {
  it('counts a level at the threshold as quiet, not as sound', () => {
    // 0.0625 is 2^-4, so it survives the trip through Float32Array unchanged.
    // A value like 0.05 does not - it comes back as 0.050000000745, which is
    // ABOVE the threshold - and the boundary is not the place to discover that.
    const options: SilenceOptions = { ...NO_PAD, threshold: 0.0625 }
    const spans = loudSpans(
      peaksFrom('x..x', 0.8, 0.0625),
      BUCKETS,
      whole(4),
      options,
    )

    expect(spans).toHaveLength(2)
  })

  it('keeps room tone that spikes above it', () => {
    const options: SilenceOptions = { ...NO_PAD, threshold: 0.02 }
    const spans = loudSpans(
      peaksFrom('x..x', 0.8, 0.03),
      BUCKETS,
      whole(4),
      options,
    )

    expect(spans).toEqual([{ startMicros: 0, endMicros: 4 * SECOND }])
  })
})

describe('removedMicros', () => {
  it('is what the trim will take out', () => {
    const range = whole(4)
    const spans = loudSpans(peaksFrom('x..x'), BUCKETS, range, NO_PAD)

    expect(removedMicros(spans, range)).toBe(2 * SECOND)
  })

  it('is nothing when everything is kept', () => {
    const range = whole(4)
    expect(removedMicros([{ ...range }], range)).toBe(0)
  })

  it('is the whole range when nothing is kept', () => {
    const range = whole(4)
    expect(removedMicros([], range)).toBe(4 * SECOND)
  })
})

describe('the defaults', () => {
  it('are the ones a caller gets without asking', () => {
    // Named so a change to them is a visible change to behaviour rather than a
    // quiet one.
    expect(DEFAULT_SILENCE_OPTIONS.threshold).toBe(0.04)
    expect(DEFAULT_SILENCE_OPTIONS.minSilenceMicros).toBe(500_000)
    expect(DEFAULT_SILENCE_OPTIONS.padMicros).toBe(80_000)
  })

  it('leave a bucket-sized pause alone', () => {
    // One bucket is 20ms. Cutting at that scale would be cutting inside words.
    const peaks = peaksFrom('xx')
    peaks[BUCKETS] = 0
    const spans = loudSpans(peaks, BUCKETS, whole(2))

    expect(spans).toEqual([{ startMicros: 0, endMicros: 2 * SECOND }])
    expect(BUCKET_MICROS).toBe(20_000)
  })
})

describe('quietSpans', () => {
  const SECOND = 1_000_000

  /** Peaks at 10 buckets a second: `pattern` marks the loud ones. */
  function peaksOf(pattern: string): Float32Array {
    return Float32Array.from([...pattern].map((c) => (c === '#' ? 0.5 : 0)))
  }

  it('finds the gap between two stretches of speech', () => {
    // Two seconds loud, two quiet, two loud.
    const peaks = peaksOf('#'.repeat(20) + ' '.repeat(8) + '#'.repeat(20))
    const quiet = quietSpans(peaks, 10, { startMicros: 0, endMicros: 4_800_000 })

    expect(quiet).toHaveLength(1)
    // Padded either side, so the pause reported is inside the real one.
    expect(quiet[0]!.startMicros).toBeGreaterThan(2 * SECOND)
    expect(quiet[0]!.endMicros).toBeLessThan(2.8 * SECOND + SECOND)
  })

  it('is exactly what loudSpans left over', () => {
    const peaks = peaksOf('#####          #####          #####')
    const range = { startMicros: 0, endMicros: 3_500_000 }
    const loud = loudSpans(peaks, 10, range)
    const quiet = quietSpans(peaks, 10, range)

    // Interleaved and covering the range exactly: a moment is speech or it is
    // a pause, never both and never neither.
    const total =
      loud.reduce((sum, s) => sum + s.endMicros - s.startMicros, 0) +
      quiet.reduce((sum, s) => sum + s.endMicros - s.startMicros, 0)
    expect(total).toBe(range.endMicros - range.startMicros)
  })

  it('reports nothing when there are no peaks, rather than everything', () => {
    // Not knowing where the pauses are is not the same as there being none.
    expect(
      quietSpans(new Float32Array(), 10, { startMicros: 0, endMicros: SECOND }),
    ).toEqual([])
  })

  it('reports the whole range when none of it is loud', () => {
    const quiet = quietSpans(peaksOf('          '), 10, {
      startMicros: 0,
      endMicros: SECOND,
    })
    expect(quiet).toEqual([{ startMicros: 0, endMicros: SECOND }])
  })

  it('reports nothing when all of it is loud', () => {
    expect(
      quietSpans(peaksOf('##########'), 10, {
        startMicros: 0,
        endMicros: SECOND,
      }),
    ).toEqual([])
  })
})
