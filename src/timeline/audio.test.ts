import { describe, expect, it } from 'vitest'
import {
  addKeyframe,
  addSegment,
  addSource,
  addTrack,
  audioTracks,
  moveSegment,
  setSegmentProperties,
  soundTracks,
  splitSegmentAt,
  timelineDuration,
  trimSegmentEnd,
  trimSegmentStart,
  videoSegmentAt,
  visibleVideoSegmentsAt,
} from './operations'
import {
  MAIN_AUDIO_TRACK_ID,
  MAIN_TEXT_TRACK_ID,
  MAIN_VIDEO_TRACK_ID,
  audioContent,
  emptyProject,
  findSegment,
  segmentDuration,
  segmentEndMicros,
  soundContent,
  sourceHasVideo,
  volumeAt,
  type Project,
  type Segment,
  type Source,
} from './types'

const SECOND = 1_000_000

const clipSource: Source = {
  id: 'src-clip',
  name: 'clip.mp4',
  durationMicros: 10 * SECOND,
  width: 1920,
  height: 1080,
  rotation: 0,
}

/** A file with no picture: width and height of zero say so. */
const musicSource: Source = {
  id: 'src-music',
  name: 'song.mp3',
  durationMicros: 30 * SECOND,
  width: 0,
  height: 0,
  rotation: 0,
}

function withSources(): Project {
  return addSource(addSource(emptyProject(), clipSource), musicSource)
}

function addMusic(
  project: Project,
  input: {
    id?: string
    timelineStartMicros?: number
    sourceInMicros?: number
    sourceOutMicros?: number
    trackId?: string
  } = {},
): Project {
  return addSegment(project, {
    trackId: input.trackId ?? MAIN_AUDIO_TRACK_ID,
    segment: {
      id: input.id ?? 'music-1',
      timelineStartMicros: input.timelineStartMicros ?? 0,
      content: {
        kind: 'audio',
        sourceId: musicSource.id,
        sourceInMicros: input.sourceInMicros ?? 0,
        sourceOutMicros: input.sourceOutMicros ?? 4 * SECOND,
      },
    },
  })
}

function addClip(project: Project, id = 'clip-1'): Project {
  return addSegment(project, {
    trackId: MAIN_VIDEO_TRACK_ID,
    segment: {
      id,
      timelineStartMicros: 0,
      content: {
        kind: 'video',
        sourceId: clipSource.id,
        sourceInMicros: 0,
        sourceOutMicros: 3 * SECOND,
      },
    },
  })
}

function segmentById(project: Project, id: string): Segment {
  const found = findSegment(project, id)
  if (!found) throw new Error(`test setup: no segment ${id}`)
  return found.segment
}

describe('sourceHasVideo', () => {
  it('tells a clip from a piece of music', () => {
    expect(sourceHasVideo(clipSource)).toBe(true)
    expect(sourceHasVideo(musicSource)).toBe(false)
  })
})

describe('audio segments', () => {
  it('go on an audio row and derive their duration like a clip', () => {
    const project = addMusic(withSources(), { sourceOutMicros: 5 * SECOND })
    const segment = segmentById(project, 'music-1')

    expect(segmentDuration(segment)).toBe(5 * SECOND)
    expect(audioContent(segment)?.sourceId).toBe(musicSource.id)
  })

  it('cannot be put on a video or a text row', () => {
    expect(() =>
      addMusic(withSources(), { trackId: MAIN_VIDEO_TRACK_ID }),
    ).toThrow(/cannot go on a video track/)
    expect(() =>
      addMusic(withSources(), { trackId: MAIN_TEXT_TRACK_ID }),
    ).toThrow(/cannot go on a text track/)
  })

  it('cannot reach past the end of the file they play', () => {
    expect(() =>
      addMusic(withSources(), { sourceOutMicros: 31 * SECOND }),
    ).toThrow(/outside source/)
  })

  it('pack their row rather than overlapping, like video does', () => {
    const project = addMusic(withSources(), { sourceOutMicros: 4 * SECOND })

    expect(() =>
      addMusic(project, { id: 'music-2', timelineStartMicros: 2 * SECOND }),
    ).toThrow(/overlap/)
  })

  it('trim, split and move by the same rules as a clip', () => {
    let project = addMusic(withSources(), { sourceOutMicros: 6 * SECOND })

    project = trimSegmentStart(project, {
      segmentId: 'music-1',
      timelineMicros: 1 * SECOND,
    })
    expect(audioContent(segmentById(project, 'music-1'))!.sourceInMicros).toBe(
      1 * SECOND,
    )

    project = trimSegmentEnd(project, {
      segmentId: 'music-1',
      timelineMicros: 4 * SECOND,
    })
    expect(segmentEndMicros(segmentById(project, 'music-1'))).toBe(4 * SECOND)

    project = splitSegmentAt(project, {
      timelineMicros: 2 * SECOND,
      newSegmentId: 'music-1b',
      trackId: MAIN_AUDIO_TRACK_ID,
    })
    // The cut is seamless: the second half picks the source up where the
    // first left it.
    expect(audioContent(segmentById(project, 'music-1'))!.sourceOutMicros).toBe(
      audioContent(segmentById(project, 'music-1b'))!.sourceInMicros,
    )

    project = moveSegment(project, {
      segmentId: 'music-1b',
      timelineStartMicros: 8 * SECOND,
    })
    expect(segmentById(project, 'music-1b').timelineStartMicros).toBe(
      8 * SECOND,
    )
  })

  it('count towards the length of the timeline', () => {
    const project = addMusic(withSources(), {
      timelineStartMicros: 2 * SECOND,
      sourceOutMicros: 3 * SECOND,
    })

    expect(timelineDuration(project)).toBe(5 * SECOND)
  })

  it('are never drawn', () => {
    const project = addMusic(withSources())

    expect(videoSegmentAt(project, 1 * SECOND)).toBeNull()
    expect(visibleVideoSegmentsAt(project, 1 * SECOND)).toEqual([])
  })

  it('do not hide the picture on a row above or below', () => {
    const project = addMusic(addClip(withSources()))

    expect(videoSegmentAt(project, 1 * SECOND)?.segment.id).toBe('clip-1')
  })
})

describe('which rows make a sound', () => {
  it('is every video and audio row, and no text row', () => {
    const project = addTrack(withSources(), { id: 'video-2', kind: 'video' })

    expect(soundTracks(project).map((track) => track.id)).toEqual([
      MAIN_AUDIO_TRACK_ID,
      MAIN_VIDEO_TRACK_ID,
      'video-2',
    ])
    expect(audioTracks(project).map((track) => track.id)).toEqual([
      MAIN_AUDIO_TRACK_ID,
    ])
  })

  it('counts a clip, because a clip carries its own audio', () => {
    const project = addClip(withSources())
    const segment = segmentById(project, 'clip-1')

    expect(soundContent(segment)).toBeDefined()
  })

  it('does not count a caption', () => {
    const project = addSegment(withSources(), {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: {
        id: 'text-1',
        timelineStartMicros: 0,
        content: {
          kind: 'text',
          content: 'Hello',
          x: 0,
          y: 0,
          sizePx: 32,
          color: '#fff',
          durationMicros: SECOND,
        },
      },
    })

    expect(soundContent(segmentById(project, 'text-1'))).toBeUndefined()
  })
})

describe('volume', () => {
  it('is 1 until someone says otherwise', () => {
    expect(volumeAt(segmentById(addMusic(withSources()), 'music-1'), 0)).toBe(1)
  })

  it('is a fixed value once set', () => {
    const project = setSegmentProperties(addMusic(withSources()), {
      segmentId: 'music-1',
      volume: 0.25,
    })

    expect(volumeAt(segmentById(project, 'music-1'), 2 * SECOND)).toBe(0.25)
  })

  it('clamps to silence at the bottom and a sane boost at the top', () => {
    const quiet = setSegmentProperties(addMusic(withSources()), {
      segmentId: 'music-1',
      volume: -5,
    })
    const loud = setSegmentProperties(addMusic(withSources()), {
      segmentId: 'music-1',
      volume: 99,
    })

    expect(volumeAt(segmentById(quiet, 'music-1'), 0)).toBe(0)
    expect(volumeAt(segmentById(loud, 'music-1'), 0)).toBe(4)
  })

  it('applies to a clip too, which is what muting one means', () => {
    const project = setSegmentProperties(addClip(withSources()), {
      segmentId: 'clip-1',
      volume: 0,
    })

    expect(volumeAt(segmentById(project, 'clip-1'), SECOND)).toBe(0)
  })

  it('fades on the same clock as any other animation', () => {
    let project = addMusic(withSources(), { sourceOutMicros: 4 * SECOND })
    project = addKeyframe(project, {
      segmentId: 'music-1',
      property: 'volume',
      offsetMicros: 0,
      value: 0,
    })
    project = addKeyframe(project, {
      segmentId: 'music-1',
      property: 'volume',
      offsetMicros: 4 * SECOND,
      value: 1,
    })

    const segment = segmentById(project, 'music-1')
    expect(volumeAt(segment, 0)).toBe(0)
    expect(volumeAt(segment, 2 * SECOND)).toBe(0.5)
    expect(volumeAt(segment, 4 * SECOND)).toBe(1)
  })

  it('carries its fade when the segment moves', () => {
    let project = addMusic(withSources(), { sourceOutMicros: 4 * SECOND })
    project = addKeyframe(project, {
      segmentId: 'music-1',
      property: 'volume',
      offsetMicros: 0,
      value: 0,
    })
    project = addKeyframe(project, {
      segmentId: 'music-1',
      property: 'volume',
      offsetMicros: 4 * SECOND,
      value: 1,
    })
    project = moveSegment(project, {
      segmentId: 'music-1',
      timelineStartMicros: 10 * SECOND,
    })

    expect(volumeAt(segmentById(project, 'music-1'), 12 * SECOND)).toBe(0.5)
  })

  it('does not leak into the transform', () => {
    const project = setSegmentProperties(addClip(withSources()), {
      segmentId: 'clip-1',
      volume: 0.5,
    })
    const segment = segmentById(project, 'clip-1')

    // Turning a clip down must not fade it out as well.
    expect(volumeAt(segment, 0)).toBe(0.5)
    expect(segment.properties?.opacity).toBeUndefined()
  })
})

describe('audio state shape', () => {
  it('stays plain JSON', () => {
    let project = addMusic(withSources())
    project = setSegmentProperties(project, {
      segmentId: 'music-1',
      volume: 0.4,
    })
    project = addKeyframe(project, {
      segmentId: 'music-1',
      property: 'volume',
      offsetMicros: 0,
      value: 1,
    })

    expect(JSON.parse(JSON.stringify(project))).toEqual(project)
  })
})
