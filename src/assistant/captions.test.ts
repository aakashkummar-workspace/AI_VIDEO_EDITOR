import { describe, expect, it } from 'vitest'
import { DEFAULT_CAPTION_OPTIONS, captionSteps, segmentsUsing } from './captions'
import type { Transcript } from './transcript'
import {
  MAIN_TEXT_TRACK_ID,
  MAIN_VIDEO_TRACK_ID,
  emptyProject,
  type Segment,
  type TextContent,
  type Track,
} from '../timeline/types'

const SECOND = 1_000_000

const composition = { width: 1920, height: 1080 }

function textTrack(): Track {
  return { id: MAIN_TEXT_TRACK_ID, kind: 'text', segments: [] }
}

/** A clip playing source 10s..20s, sitting at 5s on the timeline. */
function clip(overrides: Partial<Segment> = {}): Segment {
  return {
    id: 'clip-1',
    timelineStartMicros: 5 * SECOND,
    content: {
      kind: 'video',
      sourceId: 'src-a',
      sourceInMicros: 10 * SECOND,
      sourceOutMicros: 20 * SECOND,
    },
    ...overrides,
  }
}

function transcript(
  lines: { start: number; end: number; text: string }[],
): Transcript {
  return {
    language: 'en',
    duration: 30,
    text: lines.map((line) => line.text).join(' '),
    segments: lines.map((line) => ({ ...line, words: [] })),
  }
}

function counter() {
  let next = 0
  return () => `cap-${++next}`
}

/** The text content of a step, for asserting on what was built. */
function contentOf(step: { input: unknown }): TextContent {
  const input = step.input as { segment: Segment }
  if (input.segment.content.kind !== 'text') throw new Error('not text')
  return input.segment.content
}

function startOf(step: { input: unknown }): number {
  return (step.input as { segment: Segment }).segment.timelineStartMicros
}

describe('captions from a transcript', () => {
  it('maps source time onto the timeline through the segment', () => {
    // The clip plays source 10s..20s at timeline 5s, so a line spoken at source
    // 12s belongs at timeline 7s. Getting this wrong is the whole bug this
    // function exists to avoid.
    const steps = captionSteps(
      clip(),
      transcript([{ start: 12, end: 13, text: 'hello there' }]),
      textTrack(),
      composition,
      counter(),
    )

    expect(steps).toHaveLength(1)
    expect(startOf(steps[0]!)).toBe(7 * SECOND)
    expect(contentOf(steps[0]!).durationMicros).toBe(1 * SECOND)
    expect(contentOf(steps[0]!).content).toBe('hello there')
  })

  it('leaves out what the clip does not play', () => {
    // Two lines outside the trimmed range, one inside. A caption for words
    // nobody kept would appear over footage that never said them.
    const steps = captionSteps(
      clip(),
      transcript([
        { start: 2, end: 3, text: 'before the clip' },
        { start: 15, end: 16, text: 'inside the clip' },
        { start: 25, end: 26, text: 'after the clip' },
      ]),
      textTrack(),
      composition,
      counter(),
    )

    expect(steps).toHaveLength(1)
    expect(contentOf(steps[0]!).content).toBe('inside the clip')
  })

  it('compresses the timing when the clip is sped up', () => {
    // At 2x, two seconds of speech occupies one second of timeline.
    const steps = captionSteps(
      clip({ rate: 2 }),
      transcript([{ start: 12, end: 14, text: 'quickly now' }]),
      textTrack(),
      composition,
      counter(),
    )

    expect(startOf(steps[0]!)).toBe(6 * SECOND)
    expect(contentOf(steps[0]!).durationMicros).toBe(1 * SECOND)
  })

  it('clamps a line the clip cuts off partway', () => {
    // Spoken from source 19s to 22s, but the clip ends at source 20s. The half
    // that survived should still be captioned.
    const steps = captionSteps(
      clip(),
      transcript([{ start: 19, end: 22, text: 'cut off midway' }]),
      textTrack(),
      composition,
      counter(),
    )

    expect(steps).toHaveLength(1)
    expect(startOf(steps[0]!)).toBe(14 * SECOND)
    expect(
      startOf(steps[0]!) + contentOf(steps[0]!).durationMicros,
    ).toBe(15 * SECOND)
  })

  it('captions every segment of a split clip', () => {
    // A source cut in two should caption both halves, each on its own clock.
    const first = clip()
    const second = clip({
      id: 'clip-2',
      timelineStartMicros: 100 * SECOND,
      content: {
        kind: 'video',
        sourceId: 'src-a',
        sourceInMicros: 20 * SECOND,
        sourceOutMicros: 30 * SECOND,
      },
    })
    const words = transcript([
      { start: 12, end: 13, text: 'in the first' },
      { start: 22, end: 23, text: 'in the second' },
    ])

    const mint = counter()
    const steps = [
      ...captionSteps(first, words, textTrack(), composition, mint),
      ...captionSteps(second, words, textTrack(), composition, mint),
    ]

    expect(steps).toHaveLength(2)
    expect(startOf(steps[0]!)).toBe(7 * SECOND)
    expect(startOf(steps[1]!)).toBe(102 * SECOND)
  })

  it('skips a line with nothing in it', () => {
    const steps = captionSteps(
      clip(),
      transcript([
        { start: 12, end: 13, text: '   ' },
        { start: 14, end: 15, text: 'real words' },
      ]),
      textTrack(),
      composition,
      counter(),
    )

    expect(steps).toHaveLength(1)
  })

  it('puts them in the lower third, centred, with a box behind', () => {
    const steps = captionSteps(
      clip(),
      transcript([{ start: 12, end: 13, text: 'hello' }]),
      textTrack(),
      composition,
      counter(),
    )
    const content = contentOf(steps[0]!)

    expect(content.x).toBe(960)
    expect(content.y).toBe(
      Math.round(1080 * DEFAULT_CAPTION_OPTIONS.verticalFraction),
    )
    expect(content.align).toBe('center')
    expect(content.backgroundColor).toBeTruthy()
  })

  it('lands on a text row, since that is the only kind that takes captions', () => {
    const steps = captionSteps(
      clip(),
      transcript([{ start: 12, end: 13, text: 'hello' }]),
      textTrack(),
      composition,
      counter(),
    )

    expect((steps[0]!.input as { trackId: string }).trackId).toBe(
      MAIN_TEXT_TRACK_ID,
    )
    expect(steps[0]!.mutator).toBe('addSegment')
  })

  it('has nothing to do with an empty transcript', () => {
    expect(
      captionSteps(clip(), transcript([]), textTrack(), composition, counter()),
    ).toEqual([])
  })
})

describe('segmentsUsing', () => {
  it('finds every clip playing a source, and no captions', () => {
    const project = emptyProject()
    const video = project.tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)!
    video.segments.push(clip(), clip({ id: 'clip-2' }))

    const text = project.tracks.find((t) => t.id === MAIN_TEXT_TRACK_ID)!
    text.segments.push({
      id: 'caption',
      timelineStartMicros: 0,
      content: {
        kind: 'text',
        content: 'hi',
        x: 0,
        y: 0,
        sizePx: 20,
        color: '#fff',
        durationMicros: SECOND,
      },
    })

    expect(segmentsUsing(project, 'src-a').map((s) => s.id)).toEqual([
      'clip-1',
      'clip-2',
    ])
    expect(segmentsUsing(project, 'src-b')).toEqual([])
  })
})
