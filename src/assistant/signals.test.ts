import { describe, expect, it } from 'vitest'
import {
  REPEAT_WINDOW_SECONDS,
  clarityOf,
  findRepeats,
  loudnessOfLines,
  signalsFor,
  type Line,
} from './signals'

function line(start: number, end: number, text: string): Line {
  return { start, end, text }
}

describe('clarityOf', () => {
  it('averages how sure the transcriber was', () => {
    expect(
      clarityOf({
        start: 0,
        end: 1,
        text: 'two words',
        words: [
          { start: 0, end: 0.5, word: 'two', probability: 0.9 },
          { start: 0.5, end: 1, word: 'words', probability: 0.5 },
        ],
      }),
    ).toBe(0.7)
  })

  it('says nothing rather than guessing when there are no words', () => {
    // A file too long to send word timings for has none. Reporting a clarity
    // of zero would read as "this was mumbled", which is a different claim.
    expect(clarityOf(line(0, 1, 'hello'))).toBeUndefined()
  })
})

describe('loudnessOfLines', () => {
  /** Peaks at 10 a second, so index 10 is the one-second mark. */
  function peaksOf(values: number[]): Float32Array {
    return Float32Array.from(values)
  }

  it('measures each line against the median line, not against full scale', () => {
    // Absolute level says more about the microphone and the room than about
    // the delivery.
    const lines = [line(0, 1, 'a'), line(1, 2, 'b'), line(2, 3, 'c')]
    const peaks = peaksOf([
      ...Array(10).fill(0.5),
      ...Array(10).fill(0.5),
      ...Array(10).fill(0.25),
    ])

    const levels = loudnessOfLines(lines, peaks, 10)
    expect(levels[0]).toBe(1)
    expect(levels[1]).toBe(1)
    // Half as loud as the rest of the take: what an aside sounds like.
    expect(levels[2]).toBe(0.5)
  })

  it('says nothing when nobody has measured the waveform', () => {
    // Not knowing must never read as "this was quiet".
    expect(loudnessOfLines([line(0, 1, 'a')], new Float32Array(), 10)).toEqual([
      undefined,
    ])
  })

  it('says nothing for a line outside what was measured', () => {
    const levels = loudnessOfLines(
      [line(0, 1, 'a'), line(100, 101, 'b')],
      Float32Array.from(Array(10).fill(0.5)),
      10,
    )
    expect(levels[1]).toBeUndefined()
  })
})

describe('findRepeats', () => {
  it('spots a rehearsal that is an abandoned prefix of the take', () => {
    // The commonest shape by far, and the one a symmetric comparison misses:
    // these two share every word of the shorter but only half of the longer.
    const repeats = findRepeats([
      line(0, 2, 'so the thing about it is'),
      line(3, 6, 'so the thing about it is that we built it in a week'),
    ])

    expect(repeats[1]).toBe(0)
    expect(repeats[0]).toBeUndefined()
  })

  it('ignores a line that merely shares a few common words', () => {
    const repeats = findRepeats([
      line(0, 2, 'we went to the shop'),
      line(3, 6, 'the weather was cold that day'),
    ])

    expect(repeats[1]).toBeUndefined()
  })

  it('will not call something a repeat minutes later', () => {
    // Returning to a theme is making a point, not fluffing a line.
    const repeats = findRepeats([
      line(0, 2, 'this is the important part'),
      line(REPEAT_WINDOW_SECONDS + 10, 2, 'this is the important part'),
    ])

    expect(repeats[1]).toBeUndefined()
  })

  it('points at the earlier line, so the later one is the keeper', () => {
    const repeats = findRepeats([
      line(0, 2, 'take one of this line'),
      line(4, 6, 'take one of this line'),
      line(8, 10, 'take one of this line'),
    ])

    expect(repeats).toEqual([undefined, 0, 1])
  })

  it('has nothing to say about an empty line', () => {
    expect(findRepeats([line(0, 1, '   '), line(2, 3, '   ')])[1]).toBeUndefined()
  })
})

describe('signalsFor', () => {
  it('reports only what it actually knows', () => {
    // No words and no peaks means no clarity and no loudness - and saying so by
    // omission rather than by a zero, which would be a claim.
    const [signals] = signalsFor([line(0, 1, 'hello')])
    expect(signals).toEqual({})
  })

  it('puts the three together for one line', () => {
    const lines: Line[] = [
      { start: 0, end: 1, text: 'the same words here' },
      {
        start: 2,
        end: 3,
        text: 'the same words here',
        words: [{ start: 2, end: 3, word: 'the', probability: 0.4 }],
      },
    ]
    const peaks = {
      peaks: Float32Array.from([...Array(10).fill(0.8), ...Array(20).fill(0.2)]),
      bucketsPerSecond: 10,
    }

    const [, second] = signalsFor(lines, peaks)
    expect(second!.repeatOf).toBe(0)
    expect(second!.clarity).toBe(0.4)
    expect(second!.loudness).toBeLessThan(1)
  })
})
