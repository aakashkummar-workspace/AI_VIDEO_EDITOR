import { describe, expect, it } from 'vitest'
import { checkBoundaries, spokenOnTimeline, wordsOf } from './inspect'
import { addSegment, addSource } from '../timeline/operations'
import {
  MAIN_VIDEO_TRACK_ID,
  emptyProject,
  type Project,
  type Source,
} from '../timeline/types'

const SECOND = 1_000_000

const source: Source = {
  id: 'src-a',
  name: 'talk.mp4',
  durationMicros: 60 * SECOND,
  width: 1920,
  height: 1080,
  rotation: 0,
}

/** One clip playing source 10s..20s at timeline 5s. */
function project(
  overrides: { sourceInMicros?: number; sourceOutMicros?: number } = {},
): Project {
  return addSegment(addSource(emptyProject(), source), {
    trackId: MAIN_VIDEO_TRACK_ID,
    segment: {
      id: 'clip-1',
      timelineStartMicros: 5 * SECOND,
      content: {
        kind: 'video',
        sourceId: 'src-a',
        sourceInMicros: overrides.sourceInMicros ?? 10 * SECOND,
        sourceOutMicros: overrides.sourceOutMicros ?? 20 * SECOND,
      },
    },
  })
}

const scripts = {
  'src-a': {
    segments: [
      { start: 2, end: 3, text: 'before the clip' },
      { start: 12, end: 13, text: 'hello there' },
      { start: 15, end: 16, text: 'and welcome' },
      { start: 25, end: 26, text: 'after the clip' },
    ],
  },
}

describe('spokenOnTimeline', () => {
  it('reads the timeline back in the order it would be heard', () => {
    // The point of the whole module: what the edit SAYS, not what it was asked
    // to do. Source 12s is timeline 7s for a clip playing 10s-20s at 5s.
    expect(spokenOnTimeline(project(), scripts)).toEqual([
      { atSeconds: 7, endSeconds: 8, text: 'hello there', segmentId: 'clip-1' },
      { atSeconds: 10, endSeconds: 11, text: 'and welcome', segmentId: 'clip-1' },
    ])
  })

  it('leaves out what the cut removed', () => {
    // A line spoken in a part nobody kept is not in the result, which is how an
    // agent finds out it took a sentence with it.
    const lines = spokenOnTimeline(
      project({ sourceInMicros: 14 * SECOND }),
      scripts,
    )

    expect(lines.map((line) => line.text)).toEqual(['and welcome'])
  })

  it('clamps a line the cut caught halfway', () => {
    // Half a line that survived is still heard. Dropping it would have the
    // agent cut it a second time.
    const lines = spokenOnTimeline(
      project({ sourceOutMicros: 12.5 * SECOND }),
      scripts,
    )

    expect(lines).toHaveLength(1)
    expect(lines[0]!.endSeconds).toBe(7.5)
  })

  it('names the segment, so a further cut can be aimed', () => {
    expect(spokenOnTimeline(project(), scripts)[0]!.segmentId).toBe('clip-1')
  })

  it('has nothing to say about a source nobody transcribed', () => {
    expect(spokenOnTimeline(project(), {})).toEqual([])
  })

  it('says nothing for a project with nothing on it', () => {
    expect(spokenOnTimeline(emptyProject(), scripts)).toEqual([])
  })
})

describe('checkBoundaries', () => {
  const words = [
    { start: 12, end: 12.4, word: ' hello' },
    { start: 12.5, end: 13, word: ' there' },
  ]
  const pauses = [
    { fromSeconds: 10, toSeconds: 11.8 },
    { fromSeconds: 13.2, toSeconds: 14.6 },
  ]

  it('says which word a cut would land in the middle of', () => {
    const [verdict] = checkBoundaries([12.2], words, pauses)

    expect(verdict!.insideWord).toBe('hello')
    // And where to put it instead, so this is a lookup rather than a puzzle.
    expect(verdict!.suggestedSeconds).toBe(10.9)
  })

  it('is content with a cut that lands in a pause', () => {
    const [verdict] = checkBoundaries([13.9], words, pauses)

    expect(verdict!.insideWord).toBeUndefined()
    expect(verdict!.insidePause).toEqual({ fromSeconds: 13.2, toSeconds: 14.6 })
    // Nothing to suggest: it is already where it should be.
    expect(verdict!.suggestedSeconds).toBeUndefined()
  })

  it('suggests the nearer pause, not the first one', () => {
    const [verdict] = checkBoundaries([13.05], words, pauses)
    expect(verdict!.suggestedSeconds).toBe(13.9)
  })

  it('answers for every boundary it is given, in order', () => {
    const verdicts = checkBoundaries([12.2, 13.9, 12.6], words, pauses)

    expect(verdicts.map((one) => one.atSeconds)).toEqual([12.2, 13.9, 12.6])
  })

  it('still answers when nothing has been measured', () => {
    // No words and no pauses is not knowing, which must not read as approval.
    const [verdict] = checkBoundaries([12.2], [], [])

    expect(verdict).toEqual({ atSeconds: 12.2 })
  })
})

describe('wordsOf', () => {
  it('flattens the words out of the lines that hold them', () => {
    expect(
      wordsOf({
        segments: [
          { words: [{ start: 1, end: 2, word: 'a' }] },
          { words: [{ start: 3, end: 4, word: 'b' }] },
          {},
        ],
      }),
    ).toHaveLength(2)
  })
})
