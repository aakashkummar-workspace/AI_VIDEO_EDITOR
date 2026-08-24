import { describe, expect, it } from 'vitest'
import {
  WORD_TIMING_LIMIT_WORDS,
  describeProject,
  type ProjectView,
} from './describe'
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
  name: 'interview.mp4',
  durationMicros: 60 * SECOND,
  width: 1920,
  height: 1080,
  rotation: 0,
}

function withClip(): Project {
  return addSegment(addSource(emptyProject(), source), {
    trackId: MAIN_VIDEO_TRACK_ID,
    segment: {
      id: 'clip-1',
      timelineStartMicros: 0,
      content: {
        kind: 'video',
        sourceId: 'src-a',
        sourceInMicros: 0,
        sourceOutMicros: 60 * SECOND,
      },
    },
  })
}

function view(over: Partial<ProjectView> = {}): ProjectView {
  return {
    scripts: {
      'src-a': {
        language: 'en',
        duration: 60,
        segments: [
          {
            start: 1,
            end: 4,
            text: 'we can book it here',
            words: [
              { start: 1, end: 1.2, word: ' we' },
              { start: 1.2, end: 1.5, word: ' can' },
              { start: 1.6, end: 2, word: ' book' },
            ],
          },
        ],
      },
    },
    ...over,
  }
}

describe('what the agent is told about speech', () => {
  it('sends when each word was said, as [start, end, word]', () => {
    // A transcript LINE is usually several sentences. Without the words the
    // finest cut available is a whole line, which is far coarser than anyone
    // asking for "take out that sentence" means.
    const outline = describeProject(withClip(), view())
    const line = outline.scripts![0]!.lines[0]!

    expect(line.words).toEqual([
      [1, 1.2, 'we'],
      [1.2, 1.5, 'can'],
      [1.6, 2, 'book'],
    ])
  })

  it('trims the space the transcriber puts in front of every word', () => {
    const outline = describeProject(withClip(), view())
    expect(outline.scripts![0]!.lines[0]!.words![0]![2]).toBe('we')
  })

  it('leaves the words out of a file too long to send them all', () => {
    // Five thousand words is a large request on EVERY turn, and somebody
    // editing a long interview should not pay that for every question asked.
    const many = Array.from({ length: WORD_TIMING_LIMIT_WORDS + 1 }, (_, i) => ({
      start: i / 10,
      end: i / 10 + 0.05,
      word: 'word',
    }))

    const outline = describeProject(
      withClip(),
      view({
        scripts: {
          'src-a': {
            language: 'en',
            duration: 60,
            segments: [{ start: 0, end: 500, text: 'long', words: many }],
          },
        },
      }),
    )

    expect(outline.scripts![0]!.lines[0]!.words).toBeUndefined()
    // Said out loud, so the agent knows a line is the finest boundary it has
    // rather than assuming it was given the choice.
    expect(outline.scripts![0]!.wordsOmitted).toBe(true)
  })

  it('leaves them out of a file that is simply long', () => {
    const outline = describeProject(
      withClip(),
      view({
        scripts: {
          'src-a': {
            language: 'en',
            duration: 3_600,
            segments: [
              {
                start: 0,
                end: 4,
                text: 'hello',
                words: [{ start: 0, end: 1, word: 'hello' }],
              },
            ],
          },
        },
      }),
    )

    expect(outline.scripts![0]!.lines[0]!.words).toBeUndefined()
    expect(outline.scripts![0]!.wordsOmitted).toBe(true)
  })

  it('says nothing about omission when there were no word timings at all', () => {
    const outline = describeProject(
      withClip(),
      view({
        scripts: {
          'src-a': {
            language: 'en',
            duration: 60,
            segments: [{ start: 0, end: 4, text: 'hello' }],
          },
        },
      }),
    )

    expect(outline.scripts![0]!.wordsOmitted).toBeUndefined()
  })

  it('sends where the pauses are, so a cut can land in one', () => {
    // A word's start is the moment the sound begins. Cutting exactly there
    // clips the consonant and swallows the breath before it.
    const outline = describeProject(
      withClip(),
      view({
        pauses: {
          'src-a': [
            { startMicros: 0, endMicros: 1 * SECOND },
            { startMicros: 4 * SECOND, endMicros: 6_500_000 },
          ],
        },
      }),
    )

    expect(outline.scripts![0]!.pauses).toEqual([
      [0, 1],
      [4, 6.5],
    ])
  })

  it('leaves pauses out for a source nobody has measured', () => {
    const outline = describeProject(withClip(), view())
    expect(outline.scripts![0]!.pauses).toBeUndefined()
  })

  it('has no scripts section at all when nothing has been transcribed', () => {
    expect(describeProject(withClip(), {}).scripts).toBeUndefined()
  })
})

describe('what the agent is told about the picture', () => {
  it('sends what each shot shows, in source seconds', () => {
    const outline = describeProject(withClip(), {
      visuals: {
        'src-a': {
          shots: [
            { startSeconds: 0, endSeconds: 4.5, text: 'A slate is held up.' },
            { startSeconds: 4.5, endSeconds: 60, text: 'A woman speaking.' },
          ],
        },
      },
    })

    expect(outline.visuals).toEqual([
      {
        sourceId: 'src-a',
        shots: [
          { startSeconds: 0, endSeconds: 4.5, text: 'A slate is held up.' },
          { startSeconds: 4.5, endSeconds: 60, text: 'A woman speaking.' },
        ],
      },
    ])
  })

  it('says when only part of a long film was looked at', () => {
    // Without this an agent reads the description as covering the whole file
    // and plans a cut in footage nobody has seen.
    const outline = describeProject(withClip(), {
      visuals: {
        'src-a': {
          shots: [{ startSeconds: 0, endSeconds: 4, text: 'A room.' }],
          truncatedAfterSeconds: 240,
        },
      },
    })

    expect(outline.visuals![0]!.truncatedAfterSeconds).toBe(240)
  })

  it('has no visuals section when nothing has been looked at', () => {
    expect(describeProject(withClip(), {}).visuals).toBeUndefined()
    expect(
      describeProject(withClip(), { visuals: { 'src-a': { shots: [] } } })
        .visuals,
    ).toBeUndefined()
  })

  it('keeps the words and the picture as separate answers', () => {
    // They are measured by different means - one local, one sent away - and
    // fusing them would make a file with only one of them look like it had both.
    const outline = describeProject(withClip(), {
      ...view(),
      visuals: { 'src-a': { shots: [{ startSeconds: 0, endSeconds: 4, text: 'A room.' }] } },
    })

    expect(outline.scripts).toHaveLength(1)
    expect(outline.visuals).toHaveLength(1)
  })
})

describe('what the words alone do not say', () => {
  function withSignals(
    signals: { clarity?: number; loudness?: number; repeatOf?: number }[],
  ) {
    return describeProject(withClip(), { ...view(), signals: { 'src-a': signals } })
      .scripts![0]!.lines[0]!
  }

  it('flags a line the transcriber was unsure of', () => {
    // Mumbling, an aside, a line read quietly to oneself: all look like this.
    expect(withSignals([{ clarity: 0.3 }]).unclear).toBe(true)
  })

  it('says nothing about an ordinary line', () => {
    // A clarity of 0.94 on every line is noise in the request and noise in the
    // reading. Only what is worth saying gets said.
    const line = withSignals([{ clarity: 0.95, loudness: 1.02 }])
    expect(line.unclear).toBeUndefined()
    expect(line.quiet).toBeUndefined()
    expect(line.repeatOf).toBeUndefined()
  })

  it('flags a line markedly quieter than the rest', () => {
    expect(withSignals([{ loudness: 0.4 }]).quiet).toBe(true)
  })

  it('points at the line this one repeats', () => {
    // Index rather than a flag: the agent needs to know WHICH take it is a
    // second attempt at, since the later one is usually the keeper.
    expect(withSignals([{ repeatOf: 3 }]).repeatOf).toBe(3)
  })

  it('says nothing at all when nothing has been measured', () => {
    const line = describeProject(withClip(), view()).scripts![0]!.lines[0]!
    expect(line.unclear).toBeUndefined()
    expect(line.quiet).toBeUndefined()
  })
})
