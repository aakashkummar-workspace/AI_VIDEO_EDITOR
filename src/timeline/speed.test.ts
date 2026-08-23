import { describe, expect, it } from 'vitest'
import { parseDraftText, serializeDraft } from './draft'
import {
  addSegment,
  addSource,
  setSegmentRate,
  setTransition,
  splitSegmentAt,
  timelineDuration,
  trimSegmentEnd,
  trimSegmentStart,
  videoSegmentAt,
} from './operations'
import {
  MAIN_TEXT_TRACK_ID,
  MAIN_VIDEO_TRACK_ID,
  MAX_RATE,
  MIN_RATE,
  emptyProject,
  findSegment,
  segmentDuration,
  segmentEndMicros,
  segmentRate,
  sourceMicrosAt,
  type Project,
  type Segment,
  type Source,
  type VideoContent,
} from './types'

const SECOND = 1_000_000

const source: Source = {
  id: 'src-a',
  name: 'a.mp4',
  durationMicros: 60 * SECOND,
  width: 1920,
  height: 1080,
  rotation: 0,
}

/** One clip: source 10s..18s, sitting at 2s on the timeline. */
function oneClip(): Project {
  return addSegment(addSource(emptyProject(), source), {
    trackId: MAIN_VIDEO_TRACK_ID,
    segment: {
      id: 'a',
      timelineStartMicros: 2 * SECOND,
      content: {
        kind: 'video',
        sourceId: source.id,
        sourceInMicros: 10 * SECOND,
        sourceOutMicros: 18 * SECOND,
      },
    },
  })
}

/** Two clips meeting, so a rate change has something to push along. */
function twoClips(): Project {
  const project = oneClip()
  return addSegment(project, {
    trackId: MAIN_VIDEO_TRACK_ID,
    segment: {
      id: 'b',
      timelineStartMicros: 10 * SECOND,
      content: {
        kind: 'video',
        sourceId: source.id,
        sourceInMicros: 30 * SECOND,
        sourceOutMicros: 34 * SECOND,
      },
    },
  })
}

function segmentById(project: Project, id: string): Segment {
  const found = findSegment(project, id)
  if (!found) throw new Error(`test setup: no segment ${id}`)
  return found.segment
}

function video(segment: Segment): VideoContent {
  if (segment.content.kind !== 'video') throw new Error('not video')
  return segment.content
}

describe('segmentDuration with a rate', () => {
  it('is still derived, from the source range AND the rate', () => {
    expect(segmentDuration(segmentById(oneClip(), 'a'))).toBe(8 * SECOND)

    const fast = setSegmentRate(oneClip(), { segmentId: 'a', rate: 2 })
    expect(segmentDuration(segmentById(fast, 'a'))).toBe(4 * SECOND)

    const slow = setSegmentRate(oneClip(), { segmentId: 'a', rate: 0.5 })
    expect(segmentDuration(segmentById(slow, 'a'))).toBe(16 * SECOND)
  })

  it('never stores the duration it just derived', () => {
    const fast = setSegmentRate(oneClip(), { segmentId: 'a', rate: 2 })
    expect(segmentById(fast, 'a')).not.toHaveProperty('durationMicros')
    expect(video(segmentById(fast, 'a'))).toEqual(video(segmentById(oneClip(), 'a')))
  })
})

describe('sourceMicrosAt', () => {
  it('walks the source at the rate the segment plays', () => {
    const fast = setSegmentRate(oneClip(), { segmentId: 'a', rate: 2 })
    const segment = segmentById(fast, 'a')

    // A second of timeline is two seconds of footage at 2x.
    expect(sourceMicrosAt(segment, 2 * SECOND)).toBe(10 * SECOND)
    expect(sourceMicrosAt(segment, 3 * SECOND)).toBe(12 * SECOND)
  })

  it('is unchanged at 1x, so nothing moves for an untouched project', () => {
    const segment = segmentById(oneClip(), 'a')

    expect(sourceMicrosAt(segment, 2 * SECOND)).toBe(10 * SECOND)
    expect(sourceMicrosAt(segment, 5 * SECOND)).toBe(13 * SECOND)
  })

  it('agrees with what the renderer resolves', () => {
    const slow = setSegmentRate(oneClip(), { segmentId: 'a', rate: 0.5 })
    const found = videoSegmentAt(slow, 6 * SECOND)

    // Four seconds into a half-speed clip is two seconds of footage.
    expect(found?.sourceMicros).toBe(12 * SECOND)
  })
})

describe('setSegmentRate', () => {
  it('holds the head and moves the tail', () => {
    const fast = setSegmentRate(oneClip(), { segmentId: 'a', rate: 2 })
    const segment = segmentById(fast, 'a')

    expect(segment.timelineStartMicros).toBe(2 * SECOND)
    expect(segmentEndMicros(segment)).toBe(6 * SECOND)
  })

  it('ripples what follows rather than running over it', () => {
    const fast = setSegmentRate(twoClips(), { segmentId: 'a', rate: 2 })

    // a was 8s and is now 4s, so b comes back four seconds.
    expect(segmentById(fast, 'b').timelineStartMicros).toBe(6 * SECOND)
    expect(timelineDuration(fast)).toBe(10 * SECOND)
  })

  it('pushes what follows along when a clip is slowed down', () => {
    const slow = setSegmentRate(twoClips(), { segmentId: 'a', rate: 0.5 })

    expect(segmentById(slow, 'b').timelineStartMicros).toBe(18 * SECOND)
  })

  it('is not cumulative: setting 2x twice is still 2x', () => {
    let project = setSegmentRate(twoClips(), { segmentId: 'a', rate: 2 })
    project = setSegmentRate(project, { segmentId: 'a', rate: 2 })

    expect(segmentDuration(segmentById(project, 'a'))).toBe(4 * SECOND)
    expect(segmentById(project, 'b').timelineStartMicros).toBe(6 * SECOND)
  })

  it('going back to 1x undoes itself exactly', () => {
    const before = twoClips()
    let project = setSegmentRate(before, { segmentId: 'a', rate: 4 })
    project = setSegmentRate(project, { segmentId: 'a', rate: 1 })

    expect(project).toEqual(before)
  })

  it('clamps to what the mixer can play', () => {
    const tooFast = setSegmentRate(oneClip(), { segmentId: 'a', rate: 99 })
    const tooSlow = setSegmentRate(oneClip(), { segmentId: 'a', rate: 0.001 })

    expect(segmentRate(segmentById(tooFast, 'a'))).toBe(MAX_RATE)
    expect(segmentRate(segmentById(tooSlow, 'a'))).toBe(MIN_RATE)
  })

  it('refuses text, which has no source to play faster', () => {
    const project = addSegment(oneClip(), {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: {
        id: 'text-1',
        timelineStartMicros: 0,
        content: {
          kind: 'text',
          content: 'Hi',
          x: 0,
          y: 0,
          sizePx: 32,
          color: '#fff',
          durationMicros: SECOND,
        },
      },
    })

    expect(() =>
      setSegmentRate(project, { segmentId: 'text-1', rate: 2 }),
    ).toThrow(/no source/)
  })

  it('refuses a rate that is not a number', () => {
    expect(() =>
      setSegmentRate(oneClip(), { segmentId: 'a', rate: Number.NaN }),
    ).toThrow(/finite/)
  })

  it('refuses to shrink a segment below a transition it blends across', () => {
    // b is 4s long with a 3s transition; at 4x it would be 1s.
    const project = setTransition(twoClips(), {
      segmentId: 'b',
      kind: 'crossfade',
      durationMicros: 3 * SECOND,
    })

    expect(() =>
      setSegmentRate(project, { segmentId: 'b', rate: 4 }),
    ).toThrow(/shorter than the transition/)
  })

  it('leaves the project untouched when it refuses', () => {
    const project = setTransition(twoClips(), {
      segmentId: 'b',
      kind: 'crossfade',
      durationMicros: 3 * SECOND,
    })

    try {
      setSegmentRate(project, { segmentId: 'b', rate: 4 })
    } catch {
      // expected
    }

    expect(segmentRate(segmentById(project, 'b'))).toBe(1)
  })
})

describe('trimming at a rate', () => {
  it('a timeline second off the head costs a rate-second of source', () => {
    let project = setSegmentRate(oneClip(), { segmentId: 'a', rate: 2 })
    project = trimSegmentStart(project, {
      segmentId: 'a',
      timelineMicros: 3 * SECOND,
    })
    const segment = segmentById(project, 'a')

    expect(segment.timelineStartMicros).toBe(3 * SECOND)
    // One second later on the timeline is two seconds later in the source.
    expect(video(segment).sourceInMicros).toBe(12 * SECOND)
  })

  it('a timeline second off the tail likewise', () => {
    let project = setSegmentRate(oneClip(), { segmentId: 'a', rate: 2 })
    project = trimSegmentEnd(project, {
      segmentId: 'a',
      timelineMicros: 5 * SECOND,
    })

    expect(segmentDuration(segmentById(project, 'a'))).toBe(3 * SECOND)
    expect(video(segmentById(project, 'a')).sourceOutMicros).toBe(16 * SECOND)
  })

  it('can reach further along the source when playing fast', () => {
    // Eight seconds of source at 4x is two seconds of timeline, and the
    // source has fifty more seconds to give.
    let project = setSegmentRate(oneClip(), { segmentId: 'a', rate: 4 })
    project = trimSegmentEnd(project, {
      segmentId: 'a',
      timelineMicros: 99 * SECOND,
    })

    expect(video(segmentById(project, 'a')).sourceOutMicros).toBe(
      source.durationMicros,
    )
    expect(segmentDuration(segmentById(project, 'a'))).toBe(12_500_000)
  })

  it('stops at the start of the timeline, whatever the rate', () => {
    // The clip sits at 2s, so its head can only come back two seconds - and
    // at 2x those two seconds cost four of source.
    let project = setSegmentRate(oneClip(), { segmentId: 'a', rate: 2 })
    project = trimSegmentStart(project, {
      segmentId: 'a',
      timelineMicros: -99 * SECOND,
    })
    const segment = segmentById(project, 'a')

    expect(segment.timelineStartMicros).toBe(0)
    expect(video(segment).sourceInMicros).toBe(6 * SECOND)
  })

  it('stops at the start of the source when that is what binds first', () => {
    // Far enough along the timeline that the source runs out first: two
    // seconds of footage at 2x is one second of timeline.
    let project = addSegment(addSource(emptyProject(), source), {
      trackId: MAIN_VIDEO_TRACK_ID,
      segment: {
        id: 'late',
        timelineStartMicros: 20 * SECOND,
        content: {
          kind: 'video',
          sourceId: source.id,
          sourceInMicros: 2 * SECOND,
          sourceOutMicros: 10 * SECOND,
        },
      },
    })
    project = setSegmentRate(project, { segmentId: 'late', rate: 2 })
    project = trimSegmentStart(project, {
      segmentId: 'late',
      timelineMicros: 0,
    })
    const segment = segmentById(project, 'late')

    expect(video(segment).sourceInMicros).toBe(0)
    expect(segment.timelineStartMicros).toBe(19 * SECOND)
  })
})

describe('splitting at a rate', () => {
  it('cuts the source where the playhead really is', () => {
    let project = setSegmentRate(oneClip(), { segmentId: 'a', rate: 2 })
    project = splitSegmentAt(project, {
      timelineMicros: 4 * SECOND,
      newSegmentId: 'a2',
      trackId: MAIN_VIDEO_TRACK_ID,
    })

    // Two seconds of timeline into a 2x clip is four seconds of source.
    expect(video(segmentById(project, 'a')).sourceOutMicros).toBe(14 * SECOND)
    expect(video(segmentById(project, 'a2')).sourceInMicros).toBe(14 * SECOND)
  })

  it('gives both halves the speed the whole was playing at', () => {
    let project = setSegmentRate(oneClip(), { segmentId: 'a', rate: 2 })
    project = splitSegmentAt(project, {
      timelineMicros: 4 * SECOND,
      newSegmentId: 'a2',
      trackId: MAIN_VIDEO_TRACK_ID,
    })

    expect(segmentRate(segmentById(project, 'a2'))).toBe(2)
    // And the two halves still add up to what the whole was.
    expect(
      segmentDuration(segmentById(project, 'a')) +
        segmentDuration(segmentById(project, 'a2')),
    ).toBe(4 * SECOND)
  })
})

describe('rate in a draft', () => {
  it('survives the round trip', () => {
    const project = setSegmentRate(twoClips(), { segmentId: 'a', rate: 0.5 })
    expect(parseDraftText(serializeDraft(project))).toEqual(project)
  })

  it('is left out entirely at 1x', () => {
    const draft = JSON.parse(serializeDraft(oneClip()))
    const row = draft.project.tracks.find(
      (track: { id: string }) => track.id === MAIN_VIDEO_TRACK_ID,
    )

    expect(row.segments[0].rate).toBeUndefined()
  })

  it('refuses a speed this version cannot play', () => {
    const draft = JSON.parse(
      serializeDraft(setSegmentRate(oneClip(), { segmentId: 'a', rate: 2 })),
    )
    const row = draft.project.tracks.find(
      (track: { id: string }) => track.id === MAIN_VIDEO_TRACK_ID,
    )
    row.segments[0].rate = 40

    expect(() => parseDraftText(JSON.stringify(draft))).toThrow(
      /speed this version cannot/,
    )
  })
})
