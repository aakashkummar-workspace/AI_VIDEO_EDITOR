import { describe, expect, it } from 'vitest'
import { parseDraftText, serializeDraft } from './draft'
import {
  addSegment,
  addSource,
  addTrack,
  removeSegmentMask,
  setSegmentBlendMode,
  setSegmentMask,
  setSegmentProperties,
  visibleVideoSegmentsAt,
} from './operations'
import {
  BLEND_MODES,
  MAIN_VIDEO_TRACK_ID,
  emptyProject,
  findSegment,
  occludesEverything,
  type Project,
  type Segment,
  type Source,
} from './types'

const SECOND = 1_000_000

/** The same shape as the default composition, so it covers it exactly. */
const source: Source = {
  id: 'src-a',
  name: 'a.mp4',
  durationMicros: 60 * SECOND,
  width: 1920,
  height: 1080,
  rotation: 0,
}

/** A lower clip with an upper one stacked right over it. */
function stacked(): Project {
  let project = addSource(emptyProject(), source)
  project = addSegment(project, {
    trackId: MAIN_VIDEO_TRACK_ID,
    segment: {
      id: 'under',
      timelineStartMicros: 0,
      content: {
        kind: 'video',
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: 4 * SECOND,
      },
    },
  })
  project = addTrack(project, { id: 'video-2', kind: 'video' })
  return addSegment(project, {
    trackId: 'video-2',
    segment: {
      id: 'over',
      timelineStartMicros: 0,
      content: {
        kind: 'video',
        sourceId: source.id,
        sourceInMicros: 10 * SECOND,
        sourceOutMicros: 14 * SECOND,
      },
    },
  })
}

function segmentById(project: Project, id: string): Segment {
  const found = findSegment(project, id)
  if (!found) throw new Error(`test setup: no segment ${id}`)
  return found.segment
}

function visibleIds(project: Project, at = SECOND): string[] {
  return visibleVideoSegmentsAt(project, at).map((entry) => entry.segment.id)
}

describe('setSegmentBlendMode', () => {
  it('is absent for normal, so an untouched segment carries nothing', () => {
    const project = setSegmentBlendMode(stacked(), {
      segmentId: 'over',
      blendMode: 'normal',
    })

    expect(segmentById(project, 'over').blendMode).toBeUndefined()
  })

  it('stores anything else', () => {
    const project = setSegmentBlendMode(stacked(), {
      segmentId: 'over',
      blendMode: 'multiply',
    })

    expect(segmentById(project, 'over').blendMode).toBe('multiply')
  })

  it('takes the mode back off again', () => {
    const before = stacked()
    let project = setSegmentBlendMode(before, {
      segmentId: 'over',
      blendMode: 'screen',
    })
    project = setSegmentBlendMode(project, {
      segmentId: 'over',
      blendMode: 'normal',
    })

    expect(project).toEqual(before)
  })

  it('accepts every mode it offers, and nothing else', () => {
    for (const blendMode of BLEND_MODES) {
      expect(() =>
        setSegmentBlendMode(stacked(), { segmentId: 'over', blendMode }),
      ).not.toThrow()
    }

    expect(() =>
      setSegmentBlendMode(stacked(), {
        segmentId: 'over',
        blendMode: 'kaleidoscope' as never,
      }),
    ).toThrow(/Unknown blend mode/)
  })
})

describe('what a blend mode means for what has to be drawn', () => {
  it('an opaque untouched segment still hides the row below', () => {
    expect(visibleIds(stacked())).toEqual(['over'])
  })

  it('a blended segment never hides it, because it reads it', () => {
    const project = setSegmentBlendMode(stacked(), {
      segmentId: 'over',
      blendMode: 'multiply',
    })

    expect(visibleIds(project)).toEqual(['under', 'over'])
    expect(
      occludesEverything(
        segmentById(project, 'over'),
        project.composition,
        project.sources,
        SECOND,
      ),
    ).toBe(false)
  })

  it('a masked segment never hides it either, since parts show through', () => {
    const project = setSegmentMask(stacked(), { segmentId: 'over' })

    expect(visibleIds(project)).toEqual(['under', 'over'])
  })
})

describe('setSegmentMask', () => {
  it('starts in the middle of the composition at half its size', () => {
    const project = setSegmentMask(stacked(), { segmentId: 'over' })

    expect(segmentById(project, 'over').mask).toEqual({
      shape: 'rectangle',
      x: 960,
      y: 540,
      width: 960,
      height: 540,
      featherPx: 0,
      inverted: false,
    })
  })

  it('changes only the fields it is given', () => {
    let project = setSegmentMask(stacked(), {
      segmentId: 'over',
      shape: 'ellipse',
    })
    project = setSegmentMask(project, { segmentId: 'over', featherPx: 24 })

    const mask = segmentById(project, 'over').mask!
    expect(mask.shape).toBe('ellipse')
    expect(mask.featherPx).toBe(24)
    expect(mask.width).toBe(960)
  })

  it('rounds to whole pixels', () => {
    const project = setSegmentMask(stacked(), {
      segmentId: 'over',
      x: 10.6,
      featherPx: 3.2,
    })
    const mask = segmentById(project, 'over').mask!

    expect(mask.x).toBe(11)
    expect(mask.featherPx).toBe(3)
  })

  it('refuses an empty shape, a negative feather, and a shape it cannot draw', () => {
    expect(() =>
      setSegmentMask(stacked(), { segmentId: 'over', width: 0 }),
    ).toThrow(/positive width and height/)

    expect(() =>
      setSegmentMask(stacked(), { segmentId: 'over', featherPx: -5 }),
    ).toThrow(/negative feather/)

    expect(() =>
      setSegmentMask(stacked(), {
        segmentId: 'over',
        shape: 'triangle' as never,
      }),
    ).toThrow(/Unknown mask shape/)
  })

  it('refuses a value that is not a number', () => {
    expect(() =>
      setSegmentMask(stacked(), { segmentId: 'over', x: Number.NaN }),
    ).toThrow(/finite/)
  })

  it('inverts, which is how a hole is cut', () => {
    const project = setSegmentMask(stacked(), {
      segmentId: 'over',
      inverted: true,
    })

    expect(segmentById(project, 'over').mask!.inverted).toBe(true)
  })

  it('comes off again', () => {
    const before = stacked()
    const project = removeSegmentMask(
      setSegmentMask(before, { segmentId: 'over' }),
      'over',
    )

    expect(project).toEqual(before)
  })
})

describe('compositing in a draft', () => {
  it('survives the round trip', () => {
    let project = setSegmentBlendMode(stacked(), {
      segmentId: 'over',
      blendMode: 'soft-light',
    })
    project = setSegmentMask(project, {
      segmentId: 'over',
      shape: 'ellipse',
      featherPx: 12,
      inverted: true,
    })

    expect(parseDraftText(serializeDraft(project))).toEqual(project)
  })

  it('leaves both out entirely when they are not used', () => {
    const draft = JSON.parse(serializeDraft(stacked()))
    const row = draft.project.tracks.find(
      (track: { id: string }) => track.id === MAIN_VIDEO_TRACK_ID,
    )

    expect(row.segments[0].blendMode).toBeUndefined()
    expect(row.segments[0].mask).toBeUndefined()
  })

  it('refuses a blend mode this version does not know', () => {
    const draft = JSON.parse(
      serializeDraft(
        setSegmentBlendMode(stacked(), {
          segmentId: 'over',
          blendMode: 'multiply',
        }),
      ),
    )
    const row = draft.project.tracks.find(
      (track: { id: string }) => track.id === 'video-2',
    )
    row.segments[0].blendMode = 'kaleidoscope'

    expect(() => parseDraftText(JSON.stringify(draft))).toThrow(
      /blend mode this version does not know/,
    )
  })

  it('refuses a mask with no area', () => {
    const draft = JSON.parse(
      serializeDraft(setSegmentMask(stacked(), { segmentId: 'over' })),
    )
    const row = draft.project.tracks.find(
      (track: { id: string }) => track.id === 'video-2',
    )
    row.segments[0].mask.width = 0

    expect(() => parseDraftText(JSON.stringify(draft))).toThrow(/no area/)
  })
})

describe('compositing alongside everything else', () => {
  it('a transform and a blend mode both apply', () => {
    let project = setSegmentBlendMode(stacked(), {
      segmentId: 'over',
      blendMode: 'screen',
    })
    project = setSegmentProperties(project, {
      segmentId: 'over',
      scale: 0.5,
      opacity: 0.8,
    })
    const segment = segmentById(project, 'over')

    expect(segment.blendMode).toBe('screen')
    expect(segment.properties).toEqual({ scale: 0.5, opacity: 0.8 })
  })

  it('stays plain JSON', () => {
    let project = setSegmentBlendMode(stacked(), {
      segmentId: 'over',
      blendMode: 'difference',
    })
    project = setSegmentMask(project, { segmentId: 'over', shape: 'ellipse' })

    expect(JSON.parse(JSON.stringify(project))).toEqual(project)
  })
})
