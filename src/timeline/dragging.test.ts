import { describe, expect, it } from 'vitest'
import {
  EDGE_GRAB_PIXELS,
  applyDrag,
  clampSegmentStart,
  dragPreviewMicros,
  dragToOperation,
  legalStartRange,
  segmentZoneAt,
} from './dragging'
import { addSegment, addSource, addTrack } from './operations'
import {
  MAIN_TEXT_TRACK_ID,
  MAIN_VIDEO_TRACK_ID,
  emptyProject,
  findSegment,
  segmentDuration,
  segmentEndMicros,
  type Project,
  type Segment,
  type Source,
  type VideoContent,
} from './types'

const SECOND = 1_000_000

const source: Source = {
  id: 'src-a',
  name: 'a.mp4',
  durationMicros: 10 * SECOND,
  width: 320,
  height: 240,
  rotation: 0,
}

function addClip(
  project: Project,
  input: {
    id: string
    sourceInMicros: number
    sourceOutMicros: number
    timelineStartMicros: number
    trackId?: string
  },
): Project {
  return addSegment(project, {
    trackId: input.trackId ?? MAIN_VIDEO_TRACK_ID,
    segment: {
      id: input.id,
      timelineStartMicros: input.timelineStartMicros,
      content: {
        kind: 'video',
        sourceId: source.id,
        sourceInMicros: input.sourceInMicros,
        sourceOutMicros: input.sourceOutMicros,
      },
    },
  })
}

/** One clip: source 2s..5s, sitting at 1s on the timeline. */
function oneClip(): Project {
  return addClip(addSource(emptyProject(), source), {
    id: 'clip-1',
    sourceInMicros: 2 * SECOND,
    sourceOutMicros: 5 * SECOND,
    timelineStartMicros: 1 * SECOND,
  })
}

/** Two clips with a gap: 0-2s and 5-7s. */
function twoClips(): Project {
  let project = addClip(addSource(emptyProject(), source), {
    id: 'left',
    sourceInMicros: 0,
    sourceOutMicros: 2 * SECOND,
    timelineStartMicros: 0,
  })
  project = addClip(project, {
    id: 'right',
    sourceInMicros: 0,
    sourceOutMicros: 2 * SECOND,
    timelineStartMicros: 5 * SECOND,
  })
  return project
}

function clipById(project: Project, id: string): Segment {
  const found = findSegment(project, id)
  if (!found) throw new Error(`test setup: no segment ${id}`)
  return found.segment
}

function video(segment: Segment): VideoContent {
  if (segment.content.kind !== 'video') {
    throw new Error(`test setup: segment ${segment.id} is not video`)
  }
  return segment.content
}

function segmentsOn(project: Project, trackId: string): Segment[] {
  const track = project.tracks.find((candidate) => candidate.id === trackId)
  if (!track) throw new Error(`test setup: no track ${trackId}`)
  return track.segments
}

function withCaption(project: Project, id = 'text-1'): Project {
  return addSegment(project, {
    trackId: MAIN_TEXT_TRACK_ID,
    segment: {
      id,
      timelineStartMicros: 1 * SECOND,
      content: {
        kind: 'text',
        content: 'Hello',
        x: 0,
        y: 0,
        sizePx: 32,
        color: '#ffffff',
        durationMicros: 2 * SECOND,
      },
    },
  })
}

describe('segmentZoneAt', () => {
  it('grabs the head within the edge margin', () => {
    expect(segmentZoneAt(0, 200)).toBe('trim-start')
    expect(segmentZoneAt(EDGE_GRAB_PIXELS, 200)).toBe('trim-start')
  })

  it('grabs the tail within the edge margin', () => {
    expect(segmentZoneAt(200, 200)).toBe('trim-end')
    expect(segmentZoneAt(200 - EDGE_GRAB_PIXELS, 200)).toBe('trim-end')
  })

  it('moves the segment anywhere in between', () => {
    expect(segmentZoneAt(EDGE_GRAB_PIXELS + 1, 200)).toBe('move')
    expect(segmentZoneAt(100, 200)).toBe('move')
    expect(segmentZoneAt(200 - EDGE_GRAB_PIXELS - 1, 200)).toBe('move')
  })

  it('is all edges on a segment too narrow to have a middle', () => {
    // Otherwise a very short segment could never be trimmed back open.
    expect(segmentZoneAt(1, 8)).toBe('trim-start')
    expect(segmentZoneAt(7, 8)).toBe('trim-end')
  })
})

describe('legalStartRange', () => {
  it('runs from zero to forever for a lone segment', () => {
    const range = legalStartRange(oneClip(), 'clip-1')

    expect(range.minMicros).toBe(0)
    expect(range.maxMicros).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('stops at the neighbours on both sides', () => {
    let project = twoClips()
    project = addClip(project, {
      id: 'middle',
      sourceInMicros: 0,
      sourceOutMicros: SECOND,
      timelineStartMicros: 3 * SECOND,
    })

    const range = legalStartRange(project, 'middle')

    // May slide from the left clip's end up to where its own tail would meet
    // the right clip's head.
    expect(range.minMicros).toBe(2 * SECOND)
    expect(range.maxMicros).toBe(4 * SECOND)
  })

  it('has no neighbours to stop at on a row that allows overlap', () => {
    let project = withCaption(emptyProject(), 'a')
    project = withCaption(project, 'b')

    const range = legalStartRange(project, 'b')

    expect(range.minMicros).toBe(0)
    expect(range.maxMicros).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('clampSegmentStart', () => {
  it('stops at a neighbour rather than overlapping it', () => {
    expect(clampSegmentStart(twoClips(), 'right', 0)).toBe(2 * SECOND)
  })

  it('never goes before the start of the timeline', () => {
    expect(clampSegmentStart(oneClip(), 'clip-1', -5 * SECOND)).toBe(0)
  })

  it('leaves a legal position alone', () => {
    expect(clampSegmentStart(twoClips(), 'right', 3 * SECOND)).toBe(3 * SECOND)
  })
})

describe('dragToOperation', () => {
  it('turns a sideways drag into a move', () => {
    const operation = dragToOperation(oneClip(), {
      segmentId: 'clip-1',
      mode: 'move',
      deltaMicros: 2 * SECOND,
    })

    expect(operation).toEqual({
      kind: 'move',
      input: { segmentId: 'clip-1', timelineStartMicros: 3 * SECOND },
    })
  })

  it('clamps a move into a neighbour', () => {
    const operation = dragToOperation(twoClips(), {
      segmentId: 'right',
      mode: 'move',
      deltaMicros: -5 * SECOND,
    })

    expect(operation).toEqual({
      kind: 'move',
      input: { segmentId: 'right', timelineStartMicros: 2 * SECOND },
    })
  })

  it('is nothing at all when the segment would not move', () => {
    expect(
      dragToOperation(oneClip(), {
        segmentId: 'clip-1',
        mode: 'move',
        deltaMicros: 0,
      }),
    ).toBeNull()

    // Already hard against a neighbour: dragging further is not an edit.
    expect(
      dragToOperation(twoClips(), {
        segmentId: 'left',
        mode: 'move',
        deltaMicros: -SECOND,
      }),
    ).toBeNull()
  })

  it('is still a move when only the row changes', () => {
    const project = addTrack(oneClip(), { id: 'video-2', kind: 'video' })

    expect(
      dragToOperation(project, {
        segmentId: 'clip-1',
        mode: 'move',
        deltaMicros: 0,
        trackId: 'video-2',
      }),
    ).toEqual({
      kind: 'move',
      input: {
        segmentId: 'clip-1',
        timelineStartMicros: 1 * SECOND,
        trackId: 'video-2',
      },
    })
  })

  it('turns an edge drag into the matching trim', () => {
    expect(
      dragToOperation(oneClip(), {
        segmentId: 'clip-1',
        mode: 'trim-start',
        deltaMicros: 500_000,
      }),
    ).toEqual({
      kind: 'trim-start',
      input: { segmentId: 'clip-1', timelineMicros: 1_500_000 },
    })

    expect(
      dragToOperation(oneClip(), {
        segmentId: 'clip-1',
        mode: 'trim-end',
        deltaMicros: -500_000,
      }),
    ).toEqual({
      kind: 'trim-end',
      input: { segmentId: 'clip-1', timelineMicros: 3_500_000 },
    })
  })

  it('is nothing for a segment that is not there', () => {
    expect(
      dragToOperation(oneClip(), {
        segmentId: 'ghost',
        mode: 'move',
        deltaMicros: SECOND,
      }),
    ).toBeNull()
  })
})

describe('applyDrag', () => {
  it('moves a segment without touching its source range', () => {
    const before = video(clipById(oneClip(), 'clip-1'))
    const after = clipById(
      applyDrag(oneClip(), {
        segmentId: 'clip-1',
        mode: 'move',
        deltaMicros: 2 * SECOND,
      }),
      'clip-1',
    )

    expect(after.timelineStartMicros).toBe(3 * SECOND)
    expect(video(after).sourceInMicros).toBe(before.sourceInMicros)
    expect(video(after).sourceOutMicros).toBe(before.sourceOutMicros)
  })

  it('head trim moves the source in-point with the head', () => {
    const after = clipById(
      applyDrag(oneClip(), {
        segmentId: 'clip-1',
        mode: 'trim-start',
        deltaMicros: SECOND,
      }),
      'clip-1',
    )

    expect(after.timelineStartMicros).toBe(2 * SECOND)
    expect(video(after).sourceInMicros).toBe(3 * SECOND)
    expect(video(after).sourceOutMicros).toBe(5 * SECOND)
  })

  it('tail trim moves the out-point only', () => {
    const after = clipById(
      applyDrag(oneClip(), {
        segmentId: 'clip-1',
        mode: 'trim-end',
        deltaMicros: -SECOND,
      }),
      'clip-1',
    )

    expect(after.timelineStartMicros).toBe(1 * SECOND)
    expect(video(after).sourceInMicros).toBe(2 * SECOND)
    expect(video(after).sourceOutMicros).toBe(4 * SECOND)
  })

  it('drops a segment onto another row', () => {
    const project = addTrack(oneClip(), { id: 'video-2', kind: 'video' })
    const after = applyDrag(project, {
      segmentId: 'clip-1',
      mode: 'move',
      deltaMicros: SECOND,
      trackId: 'video-2',
    })

    expect(segmentsOn(after, MAIN_VIDEO_TRACK_ID)).toHaveLength(0)
    expect(segmentsOn(after, 'video-2').map((s) => s.id)).toEqual(['clip-1'])
    expect(clipById(after, 'clip-1').timelineStartMicros).toBe(2 * SECOND)
  })

  it('snaps back rather than throwing when a row refuses the drop', () => {
    // A video segment has no business on the text row.
    const project = withCaption(oneClip())
    const after = applyDrag(project, {
      segmentId: 'clip-1',
      mode: 'move',
      deltaMicros: 0,
      trackId: MAIN_TEXT_TRACK_ID,
    })

    expect(after).toEqual(project)
  })

  it('drags a caption like anything else', () => {
    const after = applyDrag(withCaption(emptyProject()), {
      segmentId: 'text-1',
      mode: 'move',
      deltaMicros: 2 * SECOND,
    })

    expect(clipById(after, 'text-1').timelineStartMicros).toBe(3 * SECOND)
  })

  it('returns the project untouched when the gesture is a no-op', () => {
    const project = oneClip()

    expect(
      applyDrag(project, {
        segmentId: 'clip-1',
        mode: 'move',
        deltaMicros: 0,
      }),
    ).toBe(project)
  })

  it('never throws, however absurd the gesture', () => {
    const project = twoClips()

    for (const deltaMicros of [-99 * SECOND, 99 * SECOND]) {
      for (const mode of ['move', 'trim-start', 'trim-end'] as const) {
        for (const segmentId of ['left', 'right']) {
          const after = applyDrag(project, { segmentId, mode, deltaMicros })

          // Whatever happened, the result is still a valid timeline.
          const segments = segmentsOn(after, MAIN_VIDEO_TRACK_ID)
          for (let i = 0; i < segments.length; i++) {
            expect(segmentDuration(segments[i]!)).toBeGreaterThan(0)
            if (i > 0) {
              expect(segments[i]!.timelineStartMicros).toBeGreaterThanOrEqual(
                segmentEndMicros(segments[i - 1]!),
              )
            }
          }
        }
      }
    }
  })

  it('leaves the original project alone', () => {
    const project = oneClip()
    const snapshot = structuredClone(project)

    applyDrag(project, {
      segmentId: 'clip-1',
      mode: 'move',
      deltaMicros: 3 * SECOND,
    })

    expect(project).toEqual(snapshot)
  })
})

describe('dragPreviewMicros', () => {
  it('parks on the head while moving or head-trimming', () => {
    const project = oneClip()

    expect(
      dragPreviewMicros(project, {
        segmentId: 'clip-1',
        mode: 'move',
        deltaMicros: 0,
      }),
    ).toBe(1 * SECOND)
    expect(
      dragPreviewMicros(project, {
        segmentId: 'clip-1',
        mode: 'trim-start',
        deltaMicros: 0,
      }),
    ).toBe(1 * SECOND)
  })

  it('parks just inside the tail while tail-trimming', () => {
    // The tail is exclusive, so the last visible frame is one microsecond in.
    expect(
      dragPreviewMicros(oneClip(), {
        segmentId: 'clip-1',
        mode: 'trim-end',
        deltaMicros: 0,
      }),
    ).toBe(4 * SECOND - 1)
  })

  it('is nothing for a segment that is not there', () => {
    expect(
      dragPreviewMicros(oneClip(), {
        segmentId: 'ghost',
        mode: 'move',
        deltaMicros: 0,
      }),
    ).toBeNull()
  })
})
