import { describe, expect, it } from 'vitest'
import { parseDraftText, serializeDraft } from './draft'
import {
  addSegment,
  addSource,
  removeTransition,
  setSegmentProperties,
  setTransition,
  timelineDuration,
  visibleVideoSegmentsAt,
} from './operations'
import {
  MAIN_TEXT_TRACK_ID,
  MAIN_VIDEO_TRACK_ID,
  emptyProject,
  findSegment,
  segmentEndMicros,
  transitionAlphas,
  transitionProgress,
  transitionWindow,
  type Project,
  type Segment,
  type Source,
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

/** Two clips meeting at 4s, each four seconds long. */
function twoClips(): Project {
  let project = addSource(emptyProject(), source)

  for (const [id, start, sourceIn] of [
    ['a', 0, 0],
    ['b', 4 * SECOND, 10 * SECOND],
  ] as const) {
    project = addSegment(project, {
      trackId: MAIN_VIDEO_TRACK_ID,
      segment: {
        id,
        timelineStartMicros: start,
        content: {
          kind: 'video',
          sourceId: source.id,
          sourceInMicros: sourceIn,
          sourceOutMicros: sourceIn + 4 * SECOND,
        },
      },
    })
  }

  return project
}

function segmentById(project: Project, id: string): Segment {
  const found = findSegment(project, id)
  if (!found) throw new Error(`test setup: no segment ${id}`)
  return found.segment
}

function crossfade(project: Project, durationMicros = SECOND): Project {
  return setTransition(project, {
    segmentId: 'b',
    kind: 'crossfade',
    durationMicros,
  })
}

describe('transitionProgress', () => {
  it('is null where there is no transition', () => {
    expect(transitionProgress(segmentById(twoClips(), 'b'), 4 * SECOND)).toBe(
      null,
    )
  })

  it('runs from 0 at the head to just under 1 at the end of the window', () => {
    const segment = segmentById(crossfade(twoClips(), 2 * SECOND), 'b')
    const start = segment.timelineStartMicros

    expect(transitionProgress(segment, start)).toBe(0)
    expect(transitionProgress(segment, start + 1 * SECOND)).toBe(0.5)
    expect(transitionProgress(segment, start + 2 * SECOND)).toBe(null)
    expect(transitionProgress(segment, start - 1)).toBe(null)
  })

  it('reports the window it covers', () => {
    const segment = segmentById(crossfade(twoClips()), 'b')

    expect(transitionWindow(segment)).toEqual({
      startMicros: segment.timelineStartMicros,
      endMicros: segment.timelineStartMicros + SECOND,
    })
  })
})

describe('transitionAlphas', () => {
  it('crossfades by drawing the incoming over a solid outgoing', () => {
    // Alpha compositing of in at p over out IS in*p + out*(1-p), so the
    // dissolve falls out of the maths rather than being computed twice.
    expect(transitionAlphas('crossfade', 0)).toEqual({
      outgoing: 1,
      incoming: 0,
    })
    expect(transitionAlphas('crossfade', 0.5)).toEqual({
      outgoing: 1,
      incoming: 0.5,
    })
  })

  it('dips through black, with neither side visible at the midpoint', () => {
    expect(transitionAlphas('dip-to-black', 0)).toEqual({
      outgoing: 1,
      incoming: 0,
    })
    expect(transitionAlphas('dip-to-black', 0.5)).toEqual({
      outgoing: 0,
      incoming: 0,
    })
    expect(transitionAlphas('dip-to-black', 1)).toEqual({
      outgoing: 0,
      incoming: 1,
    })
  })

  it('does not fade a wipe at all, because a wipe reveals', () => {
    expect(transitionAlphas('wipe', 0.5)).toEqual({ outgoing: 1, incoming: 1 })
  })
})

describe('setTransition', () => {
  it('costs time: the incoming side and the rest of the row slide earlier', () => {
    const before = twoClips()
    const after = crossfade(before, SECOND)

    expect(segmentById(before, 'b').timelineStartMicros).toBe(4 * SECOND)
    expect(segmentById(after, 'b').timelineStartMicros).toBe(3 * SECOND)
    // The project is a second shorter, which is where the second came from.
    expect(timelineDuration(before)).toBe(8 * SECOND)
    expect(timelineDuration(after)).toBe(7 * SECOND)
  })

  it('leaves the two overlapping by exactly the transition', () => {
    const project = crossfade(twoClips(), 1_500_000)
    const a = segmentById(project, 'a')
    const b = segmentById(project, 'b')

    expect(segmentEndMicros(a) - b.timelineStartMicros).toBe(1_500_000)
  })

  it('does not change either segment, only where the later one sits', () => {
    const project = crossfade(twoClips())
    const b = segmentById(project, 'b')

    expect(b.content).toEqual({
      kind: 'video',
      sourceId: source.id,
      sourceInMicros: 10 * SECOND,
      sourceOutMicros: 14 * SECOND,
    })
  })

  it('is not cumulative when set twice', () => {
    let project = crossfade(twoClips(), SECOND)
    project = setTransition(project, {
      segmentId: 'b',
      kind: 'dip-to-black',
      durationMicros: 2 * SECOND,
    })

    expect(segmentById(project, 'b').timelineStartMicros).toBe(2 * SECOND)
    expect(segmentById(project, 'b').transitionIn).toEqual({
      kind: 'dip-to-black',
      durationMicros: 2 * SECOND,
    })
  })

  it('shortens to whatever room there is rather than refusing', () => {
    // Neither side is longer than four seconds, so nine is not on offer.
    const project = crossfade(twoClips(), 9 * SECOND)

    expect(segmentById(project, 'b').transitionIn!.durationMicros).toBe(
      4 * SECOND,
    )
  })

  it('refuses a segment with nothing before it', () => {
    expect(() =>
      setTransition(twoClips(), {
        segmentId: 'a',
        kind: 'crossfade',
        durationMicros: SECOND,
      }),
    ).toThrow(/nothing before it/)
  })

  it('refuses a boundary that is not a boundary', () => {
    // Push b away so the two no longer meet.
    let project = twoClips()
    project = addSegment(project, {
      trackId: MAIN_VIDEO_TRACK_ID,
      segment: {
        id: 'c',
        timelineStartMicros: 20 * SECOND,
        content: {
          kind: 'video',
          sourceId: source.id,
          sourceInMicros: 0,
          sourceOutMicros: SECOND,
        },
      },
    })

    expect(() =>
      setTransition(project, {
        segmentId: 'c',
        kind: 'crossfade',
        durationMicros: SECOND,
      }),
    ).toThrow(/there is a gap/)
  })

  it('refuses a text row, which has no cuts to sit at', () => {
    const project = addSegment(twoClips(), {
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
      setTransition(project, {
        segmentId: 'text-1',
        kind: 'crossfade',
        durationMicros: SECOND,
      }),
    ).toThrow(/no cuts/)
  })

  it('refuses a kind and a duration it cannot honour', () => {
    expect(() =>
      setTransition(twoClips(), {
        segmentId: 'b',
        kind: 'swirl' as never,
        durationMicros: SECOND,
      }),
    ).toThrow(/Unknown transition/)

    expect(() =>
      setTransition(twoClips(), {
        segmentId: 'b',
        kind: 'crossfade',
        durationMicros: 0,
      }),
    ).toThrow(/positive duration/)
  })

  it('will not let two transitions eat the same footage', () => {
    // The a-b transition already uses all four seconds of a AND all four of
    // b, so there is nothing left of b for a second transition to blend from.
    let project = crossfade(twoClips(), 4 * SECOND)
    project = addSegment(project, {
      trackId: MAIN_VIDEO_TRACK_ID,
      segment: {
        id: 'c',
        timelineStartMicros: segmentEndMicros(segmentById(project, 'b')),
        content: {
          kind: 'video',
          sourceId: source.id,
          sourceInMicros: 20 * SECOND,
          sourceOutMicros: 24 * SECOND,
        },
      },
    })

    expect(() =>
      setTransition(project, {
        segmentId: 'c',
        kind: 'crossfade',
        durationMicros: SECOND,
      }),
    ).toThrow(/no room for a transition/)
  })

  it('leaves room for the next transition after taking its own', () => {
    // A one second a-b transition leaves three of b for b-c to use.
    let project = crossfade(twoClips(), SECOND)
    project = addSegment(project, {
      trackId: MAIN_VIDEO_TRACK_ID,
      segment: {
        id: 'c',
        timelineStartMicros: segmentEndMicros(segmentById(project, 'b')),
        content: {
          kind: 'video',
          sourceId: source.id,
          sourceInMicros: 20 * SECOND,
          sourceOutMicros: 24 * SECOND,
        },
      },
    })

    // Asking for four gets three: what is left of b after its own window.
    project = setTransition(project, {
      segmentId: 'c',
      kind: 'crossfade',
      durationMicros: 4 * SECOND,
    })

    expect(segmentById(project, 'c').transitionIn!.durationMicros).toBe(
      3 * SECOND,
    )

    // And the two windows do not touch, so no frame is in two of them.
    const b = segmentById(project, 'b')
    const c = segmentById(project, 'c')
    expect(transitionWindow(c)!.startMicros).toBeGreaterThanOrEqual(
      transitionWindow(b)!.endMicros,
    )
  })
})

describe('removeTransition', () => {
  it('gives the time back', () => {
    const project = removeTransition(crossfade(twoClips()), 'b')

    expect(segmentById(project, 'b').timelineStartMicros).toBe(4 * SECOND)
    expect(segmentById(project, 'b').transitionIn).toBeUndefined()
    expect(timelineDuration(project)).toBe(8 * SECOND)
  })

  it('does nothing to a segment that has none', () => {
    const project = twoClips()
    expect(removeTransition(project, 'b')).toEqual(project)
  })

  it('round trips: setting then removing lands back where it started', () => {
    const before = twoClips()
    expect(removeTransition(crossfade(before, 2 * SECOND), 'b')).toEqual(before)
  })
})

describe('what is on screen during a transition', () => {
  it('is both segments, outgoing first so the incoming draws over it', () => {
    const project = crossfade(twoClips(), 2 * SECOND)
    const at = segmentById(project, 'b').timelineStartMicros + SECOND

    expect(visibleVideoSegmentsAt(project, at).map((e) => e.segment.id)).toEqual(
      ['a', 'b'],
    )
  })

  it('is one segment again either side of the window', () => {
    const project = crossfade(twoClips(), SECOND)
    const start = segmentById(project, 'b').timelineStartMicros

    expect(
      visibleVideoSegmentsAt(project, start - 1).map((e) => e.segment.id),
    ).toEqual(['a'])
    expect(
      visibleVideoSegmentsAt(project, start + SECOND).map((e) => e.segment.id),
    ).toEqual(['b'])
  })

  it('plays each side from its own material, unbroken across the cut', () => {
    const project = crossfade(twoClips(), 2 * SECOND)
    const start = segmentById(project, 'b').timelineStartMicros

    // The incoming side starts at its own in-point and runs on through the
    // cut: what used to play just after the cut now plays across it, so no
    // footage beyond either segment's range is needed.
    const atHead = visibleVideoSegmentsAt(project, start).find(
      (e) => e.segment.id === 'b',
    )!
    const later = visibleVideoSegmentsAt(project, start + 3 * SECOND).find(
      (e) => e.segment.id === 'b',
    )!

    expect(atHead.sourceMicros).toBe(10 * SECOND)
    expect(later.sourceMicros).toBe(13 * SECOND)
  })

  it('stops an opaque upper row from hiding a row it is dissolving into', () => {
    // The incoming side is partly transparent while it blends, so whatever is
    // underneath still has to be drawn.
    const project = setSegmentProperties(crossfade(twoClips(), 2 * SECOND), {
      segmentId: 'b',
      opacity: 1,
    })
    const at = segmentById(project, 'b').timelineStartMicros + SECOND

    expect(visibleVideoSegmentsAt(project, at)).toHaveLength(2)
  })
})

describe('transitions in a draft', () => {
  it('survive the round trip', () => {
    const project = crossfade(twoClips(), 1_500_000)
    expect(parseDraftText(serializeDraft(project))).toEqual(project)
  })

  it('let the overlap they explain through the validator', () => {
    const project = crossfade(twoClips(), 2 * SECOND)
    expect(() => parseDraftText(serializeDraft(project))).not.toThrow()
  })

  it('refuse an overlap bigger than the transition that explains it', () => {
    const draft = JSON.parse(serializeDraft(crossfade(twoClips(), SECOND)))
    const row = draft.project.tracks.find(
      (track: { id: string }) => track.id === MAIN_VIDEO_TRACK_ID,
    )
    // Slide the incoming side another second earlier without saying why.
    row.segments[1].timelineStartMicros -= SECOND

    expect(() => parseDraftText(JSON.stringify(draft))).toThrow(/overlap/)
  })

  it('refuse a transition this version does not know', () => {
    const draft = JSON.parse(serializeDraft(crossfade(twoClips())))
    const row = draft.project.tracks.find(
      (track: { id: string }) => track.id === MAIN_VIDEO_TRACK_ID,
    )
    row.segments[1].transitionIn.kind = 'kaleidoscope'

    expect(() => parseDraftText(JSON.stringify(draft))).toThrow(
      /transition this version does not know/,
    )
  })
})
