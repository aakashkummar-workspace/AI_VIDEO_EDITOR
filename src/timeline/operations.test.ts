import { describe, expect, it } from 'vitest'
import {
  addSegment,
  addSource,
  keepSourceSpans,
  removeSource,
  addKeyframe,
  addTrack,
  duplicateSegment,
  moveSegment,
  moveTrack,
  removeSegment,
  removeTrack,
  setComposition,
  setSegmentRate,
  setTransition,
  splitSegmentAt,
  textSegmentsAt,
  timelineDuration,
  trimSegmentEnd,
  trimSegmentStart,
  videoResolutionEndAfter,
  videoSegmentAt,
} from './operations'
import {
  DEFAULT_COMPOSITION,
  MAIN_AUDIO_TRACK_ID,
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

const otherSource: Source = { ...source, id: 'src-b', name: 'b.mp4' }

function projectWithSources(): Project {
  return addSource(addSource(emptyProject(), source), otherSource)
}

/** Places a video segment on a row, spelled out the way a caller would. */
function addClip(
  project: Project,
  input: {
    id: string
    sourceId: string
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
        sourceId: input.sourceId,
        sourceInMicros: input.sourceInMicros,
        sourceOutMicros: input.sourceOutMicros,
      },
    },
  })
}

/** A project holding one segment: source 1s..3s, sitting at 0s on the timeline. */
function oneClip(): Project {
  return addClip(projectWithSources(), {
    id: 'clip-1',
    sourceId: source.id,
    sourceInMicros: 1 * SECOND,
    sourceOutMicros: 3 * SECOND,
    timelineStartMicros: 0,
  })
}

function segmentsOn(project: Project, trackId = MAIN_VIDEO_TRACK_ID) {
  const track = project.tracks.find((candidate) => candidate.id === trackId)
  if (!track) throw new Error(`test setup: no track ${trackId}`)
  return track.segments
}

/** Shorthand for the main video row, which most of these tests work on. */
const clips = (project: Project) => segmentsOn(project)

function clipById(project: Project, id: string): Segment {
  const found = project.tracks
    .flatMap((track) => track.segments)
    .find((candidate) => candidate.id === id)
  if (!found) throw new Error(`test setup: no segment ${id}`)
  return found
}

/** The video half of a segment, for asserting on source ranges. */
function video(segment: Segment): VideoContent {
  if (segment.content.kind !== 'video') {
    throw new Error(`test setup: segment ${segment.id} is not video`)
  }
  return segment.content
}

function textSegment(
  id: string,
  timelineStartMicros: number,
  durationMicros: number,
): Segment {
  return {
    id,
    timelineStartMicros,
    content: {
      kind: 'text',
      content: 'Hello',
      x: 10,
      y: 20,
      sizePx: 32,
      color: '#ffffff',
      durationMicros,
    },
  }
}

describe('addSegment', () => {
  it('adds a video segment whose duration is derived, not stored', () => {
    const project = oneClip()
    const clip = clipById(project, 'clip-1')

    expect(clips(project)).toHaveLength(1)
    expect(segmentDuration(clip)).toBe(2 * SECOND)
    expect(Object.keys(clip).sort()).toEqual([
      'content',
      'id',
      'timelineStartMicros',
    ])
    expect(Object.keys(clip.content).sort()).toEqual([
      'kind',
      'sourceId',
      'sourceInMicros',
      'sourceOutMicros',
    ])
  })

  it('does not mutate the project it was given', () => {
    const before = projectWithSources()
    const snapshot = structuredClone(before)

    addClip(before, {
      id: 'clip-1',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: SECOND,
      timelineStartMicros: 0,
    })

    expect(before).toEqual(snapshot)
  })

  it('keeps segments sorted by timeline start', () => {
    let project = oneClip()
    project = addClip(project, {
      id: 'clip-3',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: SECOND,
      timelineStartMicros: 8 * SECOND,
    })
    project = addClip(project, {
      id: 'clip-2',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: SECOND,
      timelineStartMicros: 4 * SECOND,
    })

    expect(clips(project).map((clip) => clip.id)).toEqual([
      'clip-1',
      'clip-2',
      'clip-3',
    ])
  })

  it('rejects a segment that would overlap another on the same row', () => {
    const project = oneClip()

    expect(() =>
      addClip(project, {
        id: 'clip-2',
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: SECOND,
        timelineStartMicros: 1_500_000,
      }),
    ).toThrow(/overlap/)
  })

  it('allows a segment that starts exactly where another ends', () => {
    const project = addClip(oneClip(), {
      id: 'clip-2',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: SECOND,
      timelineStartMicros: 2 * SECOND,
    })

    expect(clips(project)).toHaveLength(2)
  })

  it('rejects a range outside the source', () => {
    expect(() =>
      addClip(projectWithSources(), {
        id: 'clip-1',
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: 11 * SECOND,
        timelineStartMicros: 0,
      }),
    ).toThrow(/outside source/)
  })

  it('rejects a zero-length segment', () => {
    expect(() =>
      addClip(projectWithSources(), {
        id: 'clip-1',
        sourceId: source.id,
        sourceInMicros: SECOND,
        sourceOutMicros: SECOND,
        timelineStartMicros: 0,
      }),
    ).toThrow(/positive duration/)
  })

  it('rejects an unknown source', () => {
    expect(() =>
      addClip(projectWithSources(), {
        id: 'clip-1',
        sourceId: 'nope',
        sourceInMicros: 0,
        sourceOutMicros: SECOND,
        timelineStartMicros: 0,
      }),
    ).toThrow(/No source/)
  })

  it('rejects non-integer microseconds', () => {
    expect(() =>
      addClip(projectWithSources(), {
        id: 'clip-1',
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: 1000.5,
        timelineStartMicros: 0,
      }),
    ).toThrow(/integer/)
  })

  it('rejects an unknown track', () => {
    expect(() =>
      addClip(projectWithSources(), {
        id: 'clip-1',
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: SECOND,
        timelineStartMicros: 0,
        trackId: 'nope',
      }),
    ).toThrow(/No track/)
  })

  it('refuses to put a video segment on a text row, or the reverse', () => {
    expect(() =>
      addClip(projectWithSources(), {
        id: 'clip-1',
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: SECOND,
        timelineStartMicros: 0,
        trackId: MAIN_TEXT_TRACK_ID,
      }),
    ).toThrow(/cannot go on a text track/)

    expect(() =>
      addSegment(projectWithSources(), {
        trackId: MAIN_VIDEO_TRACK_ID,
        segment: textSegment('t1', 0, SECOND),
      }),
    ).toThrow(/cannot go on a video track/)
  })

  it('rejects an id already used anywhere in the project', () => {
    const project = addSegment(oneClip(), {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: textSegment('text-1', 0, SECOND),
    })

    expect(() =>
      addSegment(project, {
        trackId: MAIN_TEXT_TRACK_ID,
        segment: textSegment('clip-1', 5 * SECOND, SECOND),
      }),
    ).toThrow(/already exists/)
  })
})

describe('tracks', () => {
  it('starts with one row of each kind, sound at the bottom', () => {
    const project = emptyProject()

    expect(project.tracks.map((track) => [track.id, track.kind])).toEqual([
      [MAIN_AUDIO_TRACK_ID, 'audio'],
      [MAIN_VIDEO_TRACK_ID, 'video'],
      [MAIN_TEXT_TRACK_ID, 'text'],
    ])
  })

  it('adds a row on top by default and at an index when asked', () => {
    let project = addTrack(emptyProject(), { id: 'video-2', kind: 'video' })
    expect(project.tracks.at(-1)!.id).toBe('video-2')

    project = addTrack(project, { id: 'video-0', kind: 'video', index: 0 })
    expect(project.tracks[0]!.id).toBe('video-0')
  })

  it('rejects a duplicate track id', () => {
    expect(() =>
      addTrack(emptyProject(), { id: MAIN_VIDEO_TRACK_ID, kind: 'video' }),
    ).toThrow(/already exists/)
  })

  it('removes a row and everything on it', () => {
    const project = removeTrack(oneClip(), MAIN_VIDEO_TRACK_ID)

    expect(project.tracks.map((track) => track.id)).toEqual([
      MAIN_AUDIO_TRACK_ID,
      MAIN_TEXT_TRACK_ID,
    ])
    expect(timelineDuration(project)).toBe(0)
  })

  it('reorders a row within the stack', () => {
    const project = moveTrack(emptyProject(), {
      trackId: MAIN_TEXT_TRACK_ID,
      index: 0,
    })

    expect(project.tracks.map((track) => track.id)).toEqual([
      MAIN_TEXT_TRACK_ID,
      MAIN_AUDIO_TRACK_ID,
      MAIN_VIDEO_TRACK_ID,
    ])
  })

  it('rejects reordering or removing a row that is not there', () => {
    expect(() => removeTrack(emptyProject(), 'nope')).toThrow(/No track/)
    expect(() => moveTrack(emptyProject(), { trackId: 'nope', index: 0 })).toThrow(
      /No track/,
    )
  })
})

describe('removeSegment', () => {
  it('removes the segment and leaves the gap', () => {
    let project = addClip(oneClip(), {
      id: 'clip-2',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: SECOND,
      timelineStartMicros: 5 * SECOND,
    })
    project = removeSegment(project, 'clip-1')

    expect(clips(project).map((clip) => clip.id)).toEqual(['clip-2'])
    expect(clipById(project, 'clip-2').timelineStartMicros).toBe(5 * SECOND)
  })

  it('rejects an unknown segment', () => {
    expect(() => removeSegment(oneClip(), 'nope')).toThrow(/No segment/)
  })
})

describe('moveSegment', () => {
  it('moves a segment without changing its source range', () => {
    const before = video(clipById(oneClip(), 'clip-1'))
    const project = moveSegment(oneClip(), {
      segmentId: 'clip-1',
      timelineStartMicros: 5 * SECOND,
    })
    const after = clipById(project, 'clip-1')

    expect(after.timelineStartMicros).toBe(5 * SECOND)
    expect(video(after).sourceInMicros).toBe(before.sourceInMicros)
    expect(video(after).sourceOutMicros).toBe(before.sourceOutMicros)
  })

  it('re-sorts when a segment moves past another', () => {
    const project = moveSegment(
      addClip(oneClip(), {
        id: 'clip-2',
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: SECOND,
        timelineStartMicros: 5 * SECOND,
      }),
      { segmentId: 'clip-1', timelineStartMicros: 7 * SECOND },
    )

    expect(clips(project).map((clip) => clip.id)).toEqual(['clip-2', 'clip-1'])
  })

  it('rejects a move that would overlap on a packed row', () => {
    const project = addClip(oneClip(), {
      id: 'clip-2',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 5 * SECOND,
    })

    expect(() =>
      moveSegment(project, { segmentId: 'clip-2', timelineStartMicros: SECOND }),
    ).toThrow(/overlap/)
  })

  it('rejects a negative timeline start', () => {
    expect(() =>
      moveSegment(oneClip(), { segmentId: 'clip-1', timelineStartMicros: -1 }),
    ).toThrow(/before the beginning/)
  })

  it('clamps rather than throwing on a row that allows overlap', () => {
    const project = moveSegment(
      addSegment(emptyProject(), {
        trackId: MAIN_TEXT_TRACK_ID,
        segment: textSegment('t1', 2 * SECOND, SECOND),
      }),
      { segmentId: 't1', timelineStartMicros: -5 * SECOND },
    )

    expect(clipById(project, 't1').timelineStartMicros).toBe(0)
  })

  it('moves a segment to another row of the same kind', () => {
    let project = addTrack(oneClip(), { id: 'video-2', kind: 'video' })
    project = moveSegment(project, {
      segmentId: 'clip-1',
      timelineStartMicros: 3 * SECOND,
      trackId: 'video-2',
    })

    expect(segmentsOn(project, MAIN_VIDEO_TRACK_ID)).toHaveLength(0)
    expect(segmentsOn(project, 'video-2').map((s) => s.id)).toEqual(['clip-1'])
    expect(clipById(project, 'clip-1').timelineStartMicros).toBe(3 * SECOND)
  })

  it('lets a segment cross to a row where it would not have fitted', () => {
    // clip-2 cannot sit at 0s on the main row, but the new row is empty.
    let project = addClip(oneClip(), {
      id: 'clip-2',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 5 * SECOND,
    })
    project = addTrack(project, { id: 'video-2', kind: 'video' })
    project = moveSegment(project, {
      segmentId: 'clip-2',
      timelineStartMicros: 0,
      trackId: 'video-2',
    })

    expect(segmentsOn(project, 'video-2').map((s) => s.id)).toEqual(['clip-2'])
    expect(clipById(project, 'clip-2').timelineStartMicros).toBe(0)
  })

  it('refuses to move a segment onto a row of the wrong kind', () => {
    expect(() =>
      moveSegment(oneClip(), {
        segmentId: 'clip-1',
        timelineStartMicros: 0,
        trackId: MAIN_TEXT_TRACK_ID,
      }),
    ).toThrow(/cannot go on a text track/)
  })
})

describe('trimSegmentStart', () => {
  it('moves the head and the source in-point together', () => {
    const project = trimSegmentStart(oneClip(), {
      segmentId: 'clip-1',
      timelineMicros: 500_000,
    })
    const clip = clipById(project, 'clip-1')

    expect(clip.timelineStartMicros).toBe(500_000)
    expect(video(clip).sourceInMicros).toBe(1_500_000)
    expect(video(clip).sourceOutMicros).toBe(3 * SECOND)
    expect(segmentDuration(clip)).toBe(1_500_000)
  })

  it('clamps to the start of the source when dragged too far left', () => {
    // The segment starts 1s into the source, so it can only extend 1s leftward.
    const project = trimSegmentStart(
      moveSegment(oneClip(), {
        segmentId: 'clip-1',
        timelineStartMicros: 5 * SECOND,
      }),
      { segmentId: 'clip-1', timelineMicros: 0 },
    )
    const clip = clipById(project, 'clip-1')

    expect(video(clip).sourceInMicros).toBe(0)
    expect(clip.timelineStartMicros).toBe(4 * SECOND)
  })

  it('never produces a zero or negative duration', () => {
    const project = trimSegmentStart(oneClip(), {
      segmentId: 'clip-1',
      timelineMicros: 99 * SECOND,
    })
    const clip = clipById(project, 'clip-1')

    expect(segmentDuration(clip)).toBe(1)
    expect(video(clip).sourceOutMicros).toBe(3 * SECOND)
  })

  it('clamps to the end of the previous segment', () => {
    let project = projectWithSources()
    project = addClip(project, {
      id: 'first',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 0,
    })
    project = addClip(project, {
      id: 'second',
      sourceId: source.id,
      sourceInMicros: 5 * SECOND,
      sourceOutMicros: 7 * SECOND,
      timelineStartMicros: 4 * SECOND,
    })

    project = trimSegmentStart(project, {
      segmentId: 'second',
      timelineMicros: 0,
    })
    const clip = clipById(project, 'second')

    expect(clip.timelineStartMicros).toBe(2 * SECOND)
    expect(video(clip).sourceInMicros).toBe(3 * SECOND)
    expect(clips(project)[0]!.id).toBe('first')
  })

  it('has no previous segment to stop at on a row that allows overlap', () => {
    let project = addSegment(emptyProject(), {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: textSegment('t1', 0, 4 * SECOND),
    })
    project = addSegment(project, {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: textSegment('t2', 3 * SECOND, 2 * SECOND),
    })

    project = trimSegmentStart(project, {
      segmentId: 't2',
      timelineMicros: SECOND,
    })

    expect(clipById(project, 't2').timelineStartMicros).toBe(SECOND)
    expect(segmentEndMicros(clipById(project, 't2'))).toBe(5 * SECOND)
  })
})

describe('trimSegmentEnd', () => {
  it('shortens the segment from the tail', () => {
    const project = trimSegmentEnd(oneClip(), {
      segmentId: 'clip-1',
      timelineMicros: SECOND,
    })
    const clip = clipById(project, 'clip-1')

    expect(clip.timelineStartMicros).toBe(0)
    expect(video(clip).sourceInMicros).toBe(SECOND)
    expect(video(clip).sourceOutMicros).toBe(2 * SECOND)
  })

  it('clamps to the real end of the source', () => {
    // The segment starts 1s into a 10s source, so it can reach at most 9s long.
    const project = trimSegmentEnd(oneClip(), {
      segmentId: 'clip-1',
      timelineMicros: 99 * SECOND,
    })
    const clip = clipById(project, 'clip-1')

    expect(video(clip).sourceOutMicros).toBe(source.durationMicros)
    expect(segmentEndMicros(clip)).toBe(9 * SECOND)
  })

  it('never produces a zero or negative duration', () => {
    const project = trimSegmentEnd(oneClip(), {
      segmentId: 'clip-1',
      timelineMicros: -5 * SECOND,
    })

    expect(segmentDuration(clipById(project, 'clip-1'))).toBe(1)
  })

  it('clamps to the start of the next segment', () => {
    const project = trimSegmentEnd(
      addClip(oneClip(), {
        id: 'clip-2',
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: SECOND,
        timelineStartMicros: 4 * SECOND,
      }),
      { segmentId: 'clip-1', timelineMicros: 8 * SECOND },
    )

    expect(segmentEndMicros(clipById(project, 'clip-1'))).toBe(4 * SECOND)
  })

  it('grows a text segment past its neighbour, which its row allows', () => {
    let project = addSegment(emptyProject(), {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: textSegment('t1', 0, SECOND),
    })
    project = addSegment(project, {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: textSegment('t2', 2 * SECOND, SECOND),
    })

    project = trimSegmentEnd(project, {
      segmentId: 't1',
      timelineMicros: 5 * SECOND,
    })

    expect(segmentEndMicros(clipById(project, 't1'))).toBe(5 * SECOND)
  })
})

describe('duplicateSegment', () => {
  it('puts the copy at the end of the original', () => {
    const project = duplicateSegment(oneClip(), {
      segmentId: 'clip-1',
      newSegmentId: 'clip-1-copy',
    })

    const [first, second] = clips(project)
    expect(clips(project)).toHaveLength(2)
    expect(second!.id).toBe('clip-1-copy')
    expect(second!.timelineStartMicros).toBe(segmentEndMicros(first!))
    expect(segmentDuration(second!)).toBe(segmentDuration(first!))
  })

  it('copies the source range rather than the whole file', () => {
    const project = duplicateSegment(oneClip(), {
      segmentId: 'clip-1',
      newSegmentId: 'clip-1-copy',
    })

    // The original is a two second window on a ten second file. A copy that
    // reached for the whole source would be a different clip.
    const content = clipById(project, 'clip-1-copy').content as VideoContent
    expect(content.sourceInMicros).toBe(1 * SECOND)
    expect(content.sourceOutMicros).toBe(3 * SECOND)
  })

  it('makes room on a packed row instead of overlapping', () => {
    let project = addClip(oneClip(), {
      id: 'clip-2',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 4 * SECOND,
    })
    const lengthBefore = timelineDuration(project)

    project = duplicateSegment(project, {
      segmentId: 'clip-1',
      newSegmentId: 'clip-1-copy',
    })

    // Everything after moves along by the copy's length, gap included, and the
    // project gets exactly that much longer.
    expect(clipById(project, 'clip-2').timelineStartMicros).toBe(6 * SECOND)
    expect(timelineDuration(project)).toBe(lengthBefore + 2 * SECOND)
  })

  it('copies the keyframes and effects, sharing nothing', () => {
    let project = duplicateSegment(
      addKeyframe(oneClip(), {
        segmentId: 'clip-1',
        property: 'opacity',
        offsetMicros: 0,
        value: 0.5,
      }),
      { segmentId: 'clip-1', newSegmentId: 'clip-1-copy' },
    )

    const copy = clipById(project, 'clip-1-copy')
    expect(copy.keyframes?.opacity).toEqual([{ offsetMicros: 0, value: 0.5 }])

    // Editing one must not reach the other: keyframes are measured from the
    // segment head, so two segments sharing an array would animate together.
    project = addKeyframe(project, {
      segmentId: 'clip-1',
      property: 'opacity',
      offsetMicros: 1 * SECOND,
      value: 1,
    })
    expect(clipById(project, 'clip-1-copy').keyframes?.opacity).toHaveLength(1)
    expect(clipById(project, 'clip-1').keyframes?.opacity).toHaveLength(2)
  })

  it('gives the copy no transition of its own', () => {
    let project = addClip(oneClip(), {
      id: 'clip-2',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 2 * SECOND,
    })
    project = setTransition(project, {
      segmentId: 'clip-2',
      kind: 'crossfade',
      durationMicros: SECOND / 2,
    })

    project = duplicateSegment(project, {
      segmentId: 'clip-2',
      newSegmentId: 'clip-2-copy',
    })

    // The copy sits AT the original's end rather than reaching back into it,
    // so it blends across nothing. Carrying the transition over would mean
    // overlapping a clip it is a copy of.
    expect(clipById(project, 'clip-2-copy').transitionIn).toBeUndefined()
    expect(clipById(project, 'clip-2').transitionIn).toBeDefined()
  })

  it('refuses an id that is already taken, and an id that is not there', () => {
    expect(() =>
      duplicateSegment(oneClip(), {
        segmentId: 'clip-1',
        newSegmentId: 'clip-1',
      }),
    ).toThrow()

    expect(() =>
      duplicateSegment(oneClip(), {
        segmentId: 'nothing',
        newSegmentId: 'fresh',
      }),
    ).toThrow()
  })
})

describe('splitSegmentAt', () => {
  it('cuts one segment into two touching halves', () => {
    const project = splitSegmentAt(oneClip(), {
      timelineMicros: 500_000,
      newSegmentId: 'clip-1b',
    })
    const [first, second] = clips(project)

    expect(clips(project)).toHaveLength(2)
    expect(first).toEqual({
      id: 'clip-1',
      timelineStartMicros: 0,
      content: {
        kind: 'video',
        sourceId: source.id,
        sourceInMicros: SECOND,
        sourceOutMicros: 1_500_000,
      },
    })
    expect(second).toEqual({
      id: 'clip-1b',
      timelineStartMicros: 500_000,
      content: {
        kind: 'video',
        sourceId: source.id,
        sourceInMicros: 1_500_000,
        sourceOutMicros: 3 * SECOND,
      },
    })
    expect(segmentEndMicros(first!)).toBe(second!.timelineStartMicros)
  })

  it('preserves total duration', () => {
    const before = timelineDuration(oneClip())
    const after = timelineDuration(
      splitSegmentAt(oneClip(), {
        timelineMicros: 700_000,
        newSegmentId: 'clip-1b',
      }),
    )

    expect(after).toBe(before)
  })

  it('does nothing in empty space', () => {
    const project = oneClip()
    expect(
      splitSegmentAt(project, { timelineMicros: 5 * SECOND, newSegmentId: 'x' }),
    ).toEqual(project)
  })

  it('does nothing on a boundary, so no empty half is created', () => {
    const project = oneClip()

    expect(
      splitSegmentAt(project, { timelineMicros: 0, newSegmentId: 'x' }),
    ).toEqual(project)
    expect(
      splitSegmentAt(project, {
        timelineMicros: 2 * SECOND,
        newSegmentId: 'x',
      }),
    ).toEqual(project)
  })

  it('cuts a text segment into two halves that share the style', () => {
    const project = splitSegmentAt(
      addSegment(emptyProject(), {
        trackId: MAIN_TEXT_TRACK_ID,
        segment: textSegment('t1', 0, 4 * SECOND),
      }),
      { timelineMicros: SECOND, newSegmentId: 't1b' },
    )

    expect(segmentDuration(clipById(project, 't1'))).toBe(SECOND)
    expect(segmentDuration(clipById(project, 't1b'))).toBe(3 * SECOND)
    expect(clipById(project, 't1b').content).toMatchObject({
      kind: 'text',
      content: 'Hello',
      sizePx: 32,
    })
  })

  it('cuts the topmost row that has something under the playhead', () => {
    let project = addSegment(oneClip(), {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: textSegment('t1', 0, 4 * SECOND),
    })
    project = splitSegmentAt(project, {
      timelineMicros: SECOND,
      newSegmentId: 'new',
    })

    // The text row is above the video row, so that is the one that got cut.
    expect(segmentsOn(project, MAIN_TEXT_TRACK_ID)).toHaveLength(2)
    expect(segmentsOn(project, MAIN_VIDEO_TRACK_ID)).toHaveLength(1)
  })

  it('cuts a named row even when a higher one is covered', () => {
    let project = addSegment(oneClip(), {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: textSegment('t1', 0, 4 * SECOND),
    })
    project = splitSegmentAt(project, {
      timelineMicros: SECOND,
      newSegmentId: 'new',
      trackId: MAIN_VIDEO_TRACK_ID,
    })

    expect(segmentsOn(project, MAIN_VIDEO_TRACK_ID)).toHaveLength(2)
    expect(segmentsOn(project, MAIN_TEXT_TRACK_ID)).toHaveLength(1)
  })
})

describe('timelineDuration', () => {
  it('is zero for an empty timeline', () => {
    expect(timelineDuration(emptyProject())).toBe(0)
  })

  it('is the end of the last segment, gaps included', () => {
    const project = addClip(oneClip(), {
      id: 'clip-2',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: SECOND,
      timelineStartMicros: 5 * SECOND,
    })

    expect(timelineDuration(project)).toBe(6 * SECOND)
  })

  it('counts a caption that runs past the last clip', () => {
    const project = addSegment(oneClip(), {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: textSegment('t1', 5 * SECOND, 2 * SECOND),
    })

    expect(timelineDuration(project)).toBe(7 * SECOND)
  })
})

describe('videoSegmentAt', () => {
  it('maps a timeline position to a source position', () => {
    const found = videoSegmentAt(oneClip(), 500_000)

    expect(found?.segment.id).toBe('clip-1')
    expect(found?.sourceMicros).toBe(1_500_000)
  })

  it('includes the first microsecond and excludes the last', () => {
    const project = oneClip()

    expect(videoSegmentAt(project, 0)?.sourceMicros).toBe(SECOND)
    expect(videoSegmentAt(project, 2 * SECOND - 1)?.sourceMicros).toBe(
      3 * SECOND - 1,
    )
    expect(videoSegmentAt(project, 2 * SECOND)).toBeNull()
  })

  it('returns null over a gap', () => {
    const project = addClip(oneClip(), {
      id: 'clip-2',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: SECOND,
      timelineStartMicros: 5 * SECOND,
    })

    expect(videoSegmentAt(project, 3 * SECOND)).toBeNull()
    expect(videoSegmentAt(project, 5 * SECOND)?.segment.id).toBe('clip-2')
  })

  it('picks the right segment either side of a split', () => {
    const project = splitSegmentAt(oneClip(), {
      timelineMicros: SECOND,
      newSegmentId: 'clip-1b',
    })

    expect(videoSegmentAt(project, SECOND - 1)?.segment.id).toBe('clip-1')
    expect(videoSegmentAt(project, SECOND)?.segment.id).toBe('clip-1b')
    // The cut is seamless: the source position runs on unbroken across it.
    expect(videoSegmentAt(project, SECOND - 1)?.sourceMicros).toBe(
      2 * SECOND - 1,
    )
    expect(videoSegmentAt(project, SECOND)?.sourceMicros).toBe(2 * SECOND)
  })

  it('the topmost row wins where two overlap in time', () => {
    let project = addTrack(oneClip(), { id: 'video-2', kind: 'video' })
    project = addClip(project, {
      id: 'clip-top',
      sourceId: otherSource.id,
      sourceInMicros: 0,
      sourceOutMicros: SECOND,
      timelineStartMicros: 0,
      trackId: 'video-2',
    })

    expect(videoSegmentAt(project, 0)?.segment.id).toBe('clip-top')
    // Past the top segment, the row below shows through again.
    expect(videoSegmentAt(project, 1_500_000)?.segment.id).toBe('clip-1')
  })

  it('falls through to a lower row when the upper one has a gap', () => {
    let project = addTrack(oneClip(), { id: 'video-2', kind: 'video' })
    project = addClip(project, {
      id: 'clip-top',
      sourceId: otherSource.id,
      sourceInMicros: 0,
      sourceOutMicros: SECOND,
      timelineStartMicros: 5 * SECOND,
      trackId: 'video-2',
    })

    expect(videoSegmentAt(project, 500_000)?.segment.id).toBe('clip-1')
  })
})

describe('videoResolutionEndAfter', () => {
  /** clip-1 covers 0-2s on the main row; the upper row covers 1s-3s. */
  function stacked(): Project {
    const project = addTrack(oneClip(), { id: 'video-2', kind: 'video' })
    return addClip(project, {
      id: 'upper',
      sourceId: otherSource.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 1 * SECOND,
      trackId: 'video-2',
    })
  }

  it('is the end of the segment when nothing is above it', () => {
    expect(videoResolutionEndAfter(oneClip(), 0)).toBe(2 * SECOND)
  })

  it('stops where a higher row takes over, not at the segment end', () => {
    // This is what a decoder has to respect: from 1s the upper row is showing,
    // so walking clip-1 all the way to 2s would decode a hidden row.
    expect(videoResolutionEndAfter(stacked(), 0)).toBe(1 * SECOND)
  })

  it('runs to the end of the upper segment once it is the one showing', () => {
    expect(videoResolutionEndAfter(stacked(), 1 * SECOND)).toBe(3 * SECOND)
    expect(videoResolutionEndAfter(stacked(), 2_500_000)).toBe(3 * SECOND)
  })

  it('ignores rows below the one showing', () => {
    // The lower row starting again changes nothing while the upper one covers.
    let project = stacked()
    project = addClip(project, {
      id: 'clip-2',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: SECOND,
      timelineStartMicros: 2 * SECOND,
    })

    expect(videoResolutionEndAfter(project, 1 * SECOND)).toBe(3 * SECOND)
  })

  it('is null where nothing is showing', () => {
    expect(videoResolutionEndAfter(oneClip(), 5 * SECOND)).toBeNull()
    expect(videoResolutionEndAfter(emptyProject(), 0)).toBeNull()
  })
})

describe('textSegmentsAt', () => {
  it('returns every caption showing at a moment, in stack order', () => {
    let project = addTrack(emptyProject(), { id: 'text-2', kind: 'text' })
    project = addSegment(project, {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: textSegment('lower', 0, 4 * SECOND),
    })
    project = addSegment(project, {
      trackId: 'text-2',
      segment: textSegment('upper', 0, 4 * SECOND),
    })

    expect(
      textSegmentsAt(project, SECOND).map((entry) => entry.segment.id),
    ).toEqual(['lower', 'upper'])
  })

  it('lets two captions on one row overlap', () => {
    let project = addSegment(emptyProject(), {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: textSegment('t1', 0, 4 * SECOND),
    })
    project = addSegment(project, {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: textSegment('t2', 2 * SECOND, 4 * SECOND),
    })

    expect(textSegmentsAt(project, 3 * SECOND)).toHaveLength(2)
  })
})

describe('state shape', () => {
  it('stays plain JSON through every operation', () => {
    let project = oneClip()
    project = splitSegmentAt(project, {
      timelineMicros: SECOND,
      newSegmentId: 'clip-1b',
    })
    project = trimSegmentEnd(project, {
      segmentId: 'clip-1b',
      timelineMicros: 1_800_000,
    })
    project = moveSegment(project, {
      segmentId: 'clip-1b',
      timelineStartMicros: 4 * SECOND,
    })

    expect(JSON.parse(JSON.stringify(project))).toEqual(project)
  })

  it('keeps every time value an integer', () => {
    const project = trimSegmentStart(
      splitSegmentAt(oneClip(), {
        timelineMicros: 999_999,
        newSegmentId: 'clip-1b',
      }),
      { segmentId: 'clip-1b', timelineMicros: 1_400_001 },
    )

    for (const clip of clips(project)) {
      expect(Number.isInteger(video(clip).sourceInMicros)).toBe(true)
      expect(Number.isInteger(video(clip).sourceOutMicros)).toBe(true)
      expect(Number.isInteger(clip.timelineStartMicros)).toBe(true)
    }
  })

  it('never leaves segments on a packed row overlapping or out of order', () => {
    let project = oneClip()
    project = addClip(project, {
      id: 'clip-2',
      sourceId: otherSource.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 3 * SECOND,
    })
    project = splitSegmentAt(project, {
      timelineMicros: 4 * SECOND,
      newSegmentId: 'clip-2b',
    })
    project = trimSegmentStart(project, {
      segmentId: 'clip-2',
      timelineMicros: 3_500_000,
    })

    const ordered = clips(project)
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]!.timelineStartMicros).toBeGreaterThanOrEqual(
        segmentEndMicros(ordered[i - 1]!),
      )
    }
  })
})

describe('composition', () => {
  it('starts at a usable default', () => {
    expect(emptyProject().composition).toEqual(DEFAULT_COMPOSITION)
  })

  it('is a plain editable field, independent of the footage', () => {
    // 9:16 over 320x240 landscape sources is a normal thing to want.
    const project = setComposition(oneClip(), { width: 1080, height: 1920 })

    expect(project.composition).toEqual({ width: 1080, height: 1920 })
    expect(project.sources[source.id]!.width).toBe(320)
    expect(clips(project)).toHaveLength(1)
  })

  it('rejects a non-positive or fractional size', () => {
    expect(() =>
      setComposition(emptyProject(), { width: 0, height: 100 }),
    ).toThrow(/positive/)
    expect(() =>
      setComposition(emptyProject(), { width: -10, height: 100 }),
    ).toThrow(/positive/)
    expect(() =>
      setComposition(emptyProject(), { width: 100.5, height: 100 }),
    ).toThrow(/integer/)
  })

  it('survives serialization like the rest of the project', () => {
    const project = setComposition(oneClip(), { width: 1080, height: 1080 })

    expect(JSON.parse(JSON.stringify(project))).toEqual(project)
  })
})

describe('removeSource', () => {
  it('takes the clips that were playing it with it', () => {
    // A segment pointing at a source the project no longer knows would draw
    // nothing and could not be explained to anyone looking at it.
    let project = addClip(projectWithSources(), {
      id: 'clip-a',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 0,
    })
    project = addClip(project, {
      id: 'clip-b',
      sourceId: otherSource.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 2 * SECOND,
    })

    project = removeSource(project, source.id)

    expect(project.sources[source.id]).toBeUndefined()
    expect(findSegment(project, 'clip-a')).toBeUndefined()
    // The other file, and its clip, are none of this operation's business.
    expect(project.sources[otherSource.id]).toBeDefined()
    expect(findSegment(project, 'clip-b')).toBeDefined()
  })

  it('leaves a gap rather than closing up', () => {
    // Closing up would move footage nobody asked to move, which is what
    // deleting a segment by hand already refuses to do.
    let project = addClip(projectWithSources(), {
      id: 'clip-a',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 0,
    })
    project = addClip(project, {
      id: 'clip-b',
      sourceId: otherSource.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 2 * SECOND,
    })

    project = removeSource(project, source.id)

    expect(findSegment(project, 'clip-b')!.segment.timelineStartMicros).toBe(
      2 * SECOND,
    )
  })

  it('leaves captions alone, since they play no file', () => {
    let project = addSegment(projectWithSources(), {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: textSegment('caption', 0, SECOND),
    })
    project = removeSource(project, source.id)

    expect(findSegment(project, 'caption')).toBeDefined()
  })

  it('refuses a source that is not there', () => {
    expect(() => removeSource(projectWithSources(), 'src-nope')).toThrow(
      /No source with id src-nope/,
    )
  })
})

describe('keepSourceSpans', () => {
  /** A four second clip taken from one second into the source. */
  function fourSeconds(): Project {
    return addClip(projectWithSources(), {
      id: 'clip-1',
      sourceId: source.id,
      sourceInMicros: 1 * SECOND,
      sourceOutMicros: 5 * SECOND,
      timelineStartMicros: 0,
    })
  }

  it('lays the kept parts end to end, closing the gaps', () => {
    // The whole point: what is kept plays continuously rather than leaving the
    // holes the silence used to fill.
    const project = keepSourceSpans(fourSeconds(), {
      segmentId: 'clip-1',
      spans: [
        { startMicros: 1 * SECOND, endMicros: 2 * SECOND },
        { startMicros: 4 * SECOND, endMicros: 5 * SECOND },
      ],
      newSegmentIds: ['clip-1-b'],
    })

    const [first, second] = clips(project)
    expect(clips(project)).toHaveLength(2)
    expect(first!.timelineStartMicros).toBe(0)
    expect(segmentEndMicros(first!)).toBe(1 * SECOND)
    expect(second!.timelineStartMicros).toBe(1 * SECOND)
    expect(segmentEndMicros(second!)).toBe(2 * SECOND)
  })

  it('keeps the original id for the first piece', () => {
    // So a selection, and anything else holding the id, still means something.
    const project = keepSourceSpans(fourSeconds(), {
      segmentId: 'clip-1',
      spans: [{ startMicros: 1 * SECOND, endMicros: 3 * SECOND }],
      newSegmentIds: [],
    })

    expect(clipById(project, 'clip-1')).toBeDefined()
    expect(video(clipById(project, 'clip-1')).sourceOutMicros).toBe(3 * SECOND)
  })

  it('pulls what follows earlier by however much came out', () => {
    let project = addClip(fourSeconds(), {
      id: 'clip-2',
      sourceId: otherSource.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 4 * SECOND,
    })

    project = keepSourceSpans(project, {
      segmentId: 'clip-1',
      spans: [{ startMicros: 1 * SECOND, endMicros: 2 * SECOND }],
      newSegmentIds: [],
    })

    // Three of the four seconds went, so the row closes up by three.
    expect(clipById(project, 'clip-2').timelineStartMicros).toBe(1 * SECOND)
  })

  it('scales what came out by the rate, not by the source length', () => {
    // At 2x, removing two seconds of source removes one of timeline.
    let project = setSegmentRate(fourSeconds(), {
      segmentId: 'clip-1',
      rate: 2,
    })
    project = addClip(project, {
      id: 'clip-2',
      sourceId: otherSource.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 2 * SECOND,
    })

    project = keepSourceSpans(project, {
      segmentId: 'clip-1',
      spans: [{ startMicros: 1 * SECOND, endMicros: 3 * SECOND }],
      newSegmentIds: [],
    })

    expect(segmentDuration(clipById(project, 'clip-1'))).toBe(1 * SECOND)
    expect(clipById(project, 'clip-2').timelineStartMicros).toBe(1 * SECOND)
  })

  it('gives only the first piece a transition', () => {
    // The rest start at a cut this operation just made, with nothing behind
    // them to blend from.
    let project = addClip(projectWithSources(), {
      id: 'clip-0',
      sourceId: otherSource.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 0,
    })
    project = addClip(project, {
      id: 'clip-1',
      sourceId: source.id,
      sourceInMicros: 1 * SECOND,
      sourceOutMicros: 5 * SECOND,
      timelineStartMicros: 2 * SECOND,
    })
    project = setTransition(project, {
      segmentId: 'clip-1',
      kind: 'crossfade',
      durationMicros: SECOND / 2,
    })

    project = keepSourceSpans(project, {
      segmentId: 'clip-1',
      spans: [
        { startMicros: 1 * SECOND, endMicros: 2 * SECOND },
        { startMicros: 3 * SECOND, endMicros: 4 * SECOND },
      ],
      newSegmentIds: ['clip-1-b'],
    })

    // The first piece keeps what it was blending from; the second cannot.
    expect(clipById(project, 'clip-1').transitionIn).toBeDefined()
    expect(clipById(project, 'clip-1-b').transitionIn).toBeUndefined()
  })

  it('carries the keyframes and effects onto every piece', () => {
    const project = keepSourceSpans(
      addKeyframe(fourSeconds(), {
        segmentId: 'clip-1',
        property: 'opacity',
        offsetMicros: 0,
        value: 0.5,
      }),
      {
        segmentId: 'clip-1',
        spans: [
          { startMicros: 1 * SECOND, endMicros: 2 * SECOND },
          { startMicros: 3 * SECOND, endMicros: 4 * SECOND },
        ],
        newSegmentIds: ['clip-1-b'],
      },
    )

    expect(clipById(project, 'clip-1').keyframes?.opacity).toHaveLength(1)
    expect(clipById(project, 'clip-1-b').keyframes?.opacity).toHaveLength(1)
  })

  it('refuses to keep nothing', () => {
    // Deleting the segment is a different operation, and saying so is better
    // than quietly doing it.
    expect(() =>
      keepSourceSpans(fourSeconds(), {
        segmentId: 'clip-1',
        spans: [],
        newSegmentIds: [],
      }),
    ).toThrow(/remove it instead/)
  })

  it('refuses spans out of order, overlapping, or outside the range', () => {
    const outOfOrder = () =>
      keepSourceSpans(fourSeconds(), {
        segmentId: 'clip-1',
        spans: [
          { startMicros: 3 * SECOND, endMicros: 4 * SECOND },
          { startMicros: 1 * SECOND, endMicros: 2 * SECOND },
        ],
        newSegmentIds: ['x'],
      })
    expect(outOfOrder).toThrow(/in order/)

    const past = () =>
      keepSourceSpans(fourSeconds(), {
        segmentId: 'clip-1',
        spans: [{ startMicros: 1 * SECOND, endMicros: 9 * SECOND }],
        newSegmentIds: [],
      })
    expect(past).toThrow(/outside the segment/)
  })

  it('refuses without enough ids for the pieces', () => {
    expect(() =>
      keepSourceSpans(fourSeconds(), {
        segmentId: 'clip-1',
        spans: [
          { startMicros: 1 * SECOND, endMicros: 2 * SECOND },
          { startMicros: 3 * SECOND, endMicros: 4 * SECOND },
        ],
        newSegmentIds: [],
      }),
    ).toThrow(/needs 1 new ids/)
  })

  it('refuses on text, which plays no source', () => {
    const project = addSegment(projectWithSources(), {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: textSegment('caption', 0, 2 * SECOND),
    })

    expect(() =>
      keepSourceSpans(project, {
        segmentId: 'caption',
        spans: [{ startMicros: 0, endMicros: SECOND }],
        newSegmentIds: [],
      }),
    ).toThrow(/Text has no source/)
  })
})
