import { describe, expect, it } from 'vitest'
import {
  addSegment,
  addTrack,
  moveSegment,
  removeSegment,
  setTextStyle,
  textSegmentsAt,
  timelineDuration,
  trimSegmentEnd,
  trimSegmentStart,
} from './operations'
import {
  MAIN_TEXT_TRACK_ID,
  emptyProject,
  segmentEndMicros,
  type Project,
  type Segment,
  type TextContent,
} from './types'

const SECOND = 1_000_000

/**
 * Text is a segment like any other, on a row that allows overlap. These tests
 * cover the half of the behaviour that is specific to text: the stored
 * duration, the style fields, and captions that sit on top of one another.
 */
const overlay: Segment = {
  id: 'text-1',
  timelineStartMicros: 1 * SECOND,
  content: {
    kind: 'text',
    content: 'Hello',
    x: 40,
    y: 100,
    sizePx: 32,
    color: '#ffffff',
    durationMicros: 2 * SECOND,
  },
}

function withOverlay(): Project {
  return addSegment(emptyProject(), {
    trackId: MAIN_TEXT_TRACK_ID,
    segment: overlay,
  })
}

/** A copy of the sample overlay with some fields replaced. */
function like(
  changes: Partial<Segment> & { text?: Partial<TextContent> },
): Segment {
  const { text, ...rest } = changes
  return {
    ...overlay,
    ...rest,
    content: { ...(overlay.content as TextContent), ...text },
  }
}

function overlays(project: Project): Segment[] {
  const track = project.tracks.find((t) => t.id === MAIN_TEXT_TRACK_ID)
  if (!track) throw new Error('test setup: no text track')
  return track.segments
}

function only(project: Project): Segment {
  const found = overlays(project)[0]
  if (!found) throw new Error('test setup: no overlay')
  return found
}

function style(segment: Segment): TextContent {
  if (segment.content.kind !== 'text') {
    throw new Error('test setup: not a text segment')
  }
  return segment.content
}

function add(project: Project, segment: Segment): Project {
  return addSegment(project, { trackId: MAIN_TEXT_TRACK_ID, segment })
}

describe('adding text', () => {
  it('adds an overlay with its own stored duration', () => {
    const project = withOverlay()

    expect(overlays(project)).toHaveLength(1)
    expect(segmentEndMicros(only(project))).toBe(3 * SECOND)
  })

  it('keeps overlays sorted by start', () => {
    const project = add(
      withOverlay(),
      like({ id: 'text-0', timelineStartMicros: 0 }),
    )

    expect(overlays(project).map((item) => item.id)).toEqual([
      'text-0',
      'text-1',
    ])
  })

  it('allows two overlays at the same time', () => {
    // Two captions at once is ordinary; unlike video, a text row may overlap.
    const project = add(withOverlay(), like({ id: 'text-2' }))

    expect(overlays(project)).toHaveLength(2)
    expect(textSegmentsAt(project, 2 * SECOND)).toHaveLength(2)
  })

  it('rejects a duplicate id, a negative start, or no duration', () => {
    expect(() => add(withOverlay(), overlay)).toThrow(/already exists/)
    expect(() =>
      add(emptyProject(), like({ timelineStartMicros: -1 })),
    ).toThrow(/before the beginning/)
    expect(() =>
      add(emptyProject(), like({ text: { durationMicros: 0 } })),
    ).toThrow(/positive duration/)
    expect(() => add(emptyProject(), like({ text: { sizePx: 0 } }))).toThrow(
      /positive size/,
    )
  })
})

describe('textSegmentsAt', () => {
  it('includes the first microsecond and excludes the last', () => {
    const project = withOverlay()

    expect(textSegmentsAt(project, 1 * SECOND - 1)).toHaveLength(0)
    expect(textSegmentsAt(project, 1 * SECOND)).toHaveLength(1)
    expect(textSegmentsAt(project, 3 * SECOND - 1)).toHaveLength(1)
    expect(textSegmentsAt(project, 3 * SECOND)).toHaveLength(0)
  })

  it('hands back the style alongside the segment', () => {
    const [showing] = textSegmentsAt(withOverlay(), 2 * SECOND)

    expect(showing!.content.content).toBe('Hello')
    expect(showing!.content.sizePx).toBe(32)
  })
})

describe('moving text', () => {
  it('moves without changing how long it lasts', () => {
    const moved = only(
      moveSegment(withOverlay(), {
        segmentId: 'text-1',
        timelineStartMicros: 5 * SECOND,
      }),
    )

    expect(moved.timelineStartMicros).toBe(5 * SECOND)
    expect(style(moved).durationMicros).toBe(2 * SECOND)
  })

  it('stops at the beginning of the timeline', () => {
    const moved = only(
      moveSegment(withOverlay(), {
        segmentId: 'text-1',
        timelineStartMicros: -9 * SECOND,
      }),
    )

    expect(moved.timelineStartMicros).toBe(0)
  })

  it('moves between text rows', () => {
    let project = addTrack(withOverlay(), { id: 'text-2', kind: 'text' })
    project = moveSegment(project, {
      segmentId: 'text-1',
      timelineStartMicros: 2 * SECOND,
      trackId: 'text-2',
    })

    expect(overlays(project)).toHaveLength(0)
    expect(
      project.tracks.find((t) => t.id === 'text-2')!.segments.map((s) => s.id),
    ).toEqual(['text-1'])
  })
})

describe('trimming text', () => {
  it('head trim holds the tail still', () => {
    const trimmed = only(
      trimSegmentStart(withOverlay(), {
        segmentId: 'text-1',
        timelineMicros: 2 * SECOND,
      }),
    )

    expect(trimmed.timelineStartMicros).toBe(2 * SECOND)
    expect(segmentEndMicros(trimmed)).toBe(3 * SECOND)
  })

  it('tail trim holds the head still', () => {
    const trimmed = only(
      trimSegmentEnd(withOverlay(), {
        segmentId: 'text-1',
        timelineMicros: 2 * SECOND,
      }),
    )

    expect(trimmed.timelineStartMicros).toBe(1 * SECOND)
    expect(segmentEndMicros(trimmed)).toBe(2 * SECOND)
  })

  it('never trims away to nothing', () => {
    expect(
      style(
        only(
          trimSegmentStart(withOverlay(), {
            segmentId: 'text-1',
            timelineMicros: 99 * SECOND,
          }),
        ),
      ).durationMicros,
    ).toBe(1)

    expect(
      style(
        only(
          trimSegmentEnd(withOverlay(), {
            segmentId: 'text-1',
            timelineMicros: -99 * SECOND,
          }),
        ),
      ).durationMicros,
    ).toBe(1)
  })
})

describe('setTextStyle', () => {
  it('changes only what it is given', () => {
    const styled = style(
      only(
        setTextStyle(withOverlay(), {
          segmentId: 'text-1',
          content: 'Changed',
          color: '#ff0000',
        }),
      ),
    )

    expect(styled.content).toBe('Changed')
    expect(styled.color).toBe('#ff0000')
    expect(styled.x).toBe(40)
    expect(styled.sizePx).toBe(32)
    expect(only(withOverlay()).timelineStartMicros).toBe(1 * SECOND)
  })

  it('rounds positions and refuses a size of nothing', () => {
    const styled = style(
      only(setTextStyle(withOverlay(), { segmentId: 'text-1', x: 10.6, y: 20.4 })),
    )
    expect(styled.x).toBe(11)
    expect(styled.y).toBe(20)

    expect(() =>
      setTextStyle(withOverlay(), { segmentId: 'text-1', sizePx: 0 }),
    ).toThrow(/positive size/)
  })

  it('refuses to style a video segment', () => {
    expect(() =>
      setTextStyle(withOverlay(), { segmentId: 'nope', content: 'x' }),
    ).toThrow(/No segment/)
  })
})

describe('removing text', () => {
  it('removes it and reports an unknown id', () => {
    expect(overlays(removeSegment(withOverlay(), 'text-1'))).toEqual([])
    expect(() => removeSegment(withOverlay(), 'nope')).toThrow(/No segment/)
  })
})

describe('timelineDuration with text', () => {
  it('runs to the end of an overlay past the last clip', () => {
    // An overlay hanging off the end still has to be playable.
    expect(timelineDuration(withOverlay())).toBe(3 * SECOND)
  })

  it('is still zero for an empty project', () => {
    expect(timelineDuration(emptyProject())).toBe(0)
  })
})

describe('text state shape', () => {
  it('stays plain JSON', () => {
    const project = setTextStyle(
      trimSegmentEnd(withOverlay(), {
        segmentId: 'text-1',
        timelineMicros: 2_500_000,
      }),
      { segmentId: 'text-1', content: 'x' },
    )

    expect(JSON.parse(JSON.stringify(project))).toEqual(project)
  })
})
