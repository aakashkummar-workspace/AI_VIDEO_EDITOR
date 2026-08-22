import { describe, expect, it } from 'vitest'
import {
  addOverlay,
  moveOverlay,
  overlaysAt,
  removeOverlay,
  setOverlayStyle,
  timelineDuration,
  trimOverlayEnd,
  trimOverlayStart,
} from './operations'
import { emptyProject, overlayEndMicros, type Overlay, type Project } from './types'

const SECOND = 1_000_000

const overlay: Overlay = {
  id: 'text-1',
  content: 'Hello',
  x: 40,
  y: 100,
  sizePx: 32,
  color: '#ffffff',
  timelineStartMicros: 1 * SECOND,
  durationMicros: 2 * SECOND,
}

function withOverlay(): Project {
  return addOverlay(emptyProject(), overlay)
}

function only(project: Project): Overlay {
  const found = project.overlays[0]
  if (!found) throw new Error('test setup: no overlay')
  return found
}

describe('addOverlay', () => {
  it('adds an overlay with its own stored duration', () => {
    const project = withOverlay()

    expect(project.overlays).toHaveLength(1)
    expect(overlayEndMicros(only(project))).toBe(3 * SECOND)
  })

  it('keeps overlays sorted by start', () => {
    let project = withOverlay()
    project = addOverlay(project, { ...overlay, id: 'text-0', timelineStartMicros: 0 })

    expect(project.overlays.map((item) => item.id)).toEqual(['text-0', 'text-1'])
  })

  it('allows two overlays at the same time', () => {
    // Two captions at once is ordinary; unlike clips, overlays may overlap.
    const project = addOverlay(withOverlay(), { ...overlay, id: 'text-2' })

    expect(project.overlays).toHaveLength(2)
    expect(overlaysAt(project, 2 * SECOND)).toHaveLength(2)
  })

  it('rejects a duplicate id, a negative start, or no duration', () => {
    expect(() => addOverlay(withOverlay(), overlay)).toThrow(/already exists/)
    expect(() =>
      addOverlay(emptyProject(), { ...overlay, timelineStartMicros: -1 }),
    ).toThrow(/before the beginning/)
    expect(() =>
      addOverlay(emptyProject(), { ...overlay, durationMicros: 0 }),
    ).toThrow(/positive duration/)
    expect(() =>
      addOverlay(emptyProject(), { ...overlay, sizePx: 0 }),
    ).toThrow(/positive size/)
  })
})

describe('overlaysAt', () => {
  it('includes the first microsecond and excludes the last', () => {
    const project = withOverlay()

    expect(overlaysAt(project, 1 * SECOND - 1)).toHaveLength(0)
    expect(overlaysAt(project, 1 * SECOND)).toHaveLength(1)
    expect(overlaysAt(project, 3 * SECOND - 1)).toHaveLength(1)
    expect(overlaysAt(project, 3 * SECOND)).toHaveLength(0)
  })
})

describe('moveOverlay', () => {
  it('moves without changing how long it lasts', () => {
    const moved = only(
      moveOverlay(withOverlay(), {
        overlayId: 'text-1',
        timelineStartMicros: 5 * SECOND,
      }),
    )

    expect(moved.timelineStartMicros).toBe(5 * SECOND)
    expect(moved.durationMicros).toBe(2 * SECOND)
  })

  it('stops at the beginning of the timeline', () => {
    const moved = only(
      moveOverlay(withOverlay(), {
        overlayId: 'text-1',
        timelineStartMicros: -9 * SECOND,
      }),
    )

    expect(moved.timelineStartMicros).toBe(0)
  })
})

describe('trimming an overlay', () => {
  it('head trim holds the tail still', () => {
    const trimmed = only(
      trimOverlayStart(withOverlay(), {
        overlayId: 'text-1',
        timelineMicros: 2 * SECOND,
      }),
    )

    expect(trimmed.timelineStartMicros).toBe(2 * SECOND)
    expect(overlayEndMicros(trimmed)).toBe(3 * SECOND)
  })

  it('tail trim holds the head still', () => {
    const trimmed = only(
      trimOverlayEnd(withOverlay(), {
        overlayId: 'text-1',
        timelineMicros: 2 * SECOND,
      }),
    )

    expect(trimmed.timelineStartMicros).toBe(1 * SECOND)
    expect(overlayEndMicros(trimmed)).toBe(2 * SECOND)
  })

  it('never trims away to nothing', () => {
    expect(
      only(
        trimOverlayStart(withOverlay(), {
          overlayId: 'text-1',
          timelineMicros: 99 * SECOND,
        }),
      ).durationMicros,
    ).toBe(1)

    expect(
      only(
        trimOverlayEnd(withOverlay(), {
          overlayId: 'text-1',
          timelineMicros: -99 * SECOND,
        }),
      ).durationMicros,
    ).toBe(1)
  })
})

describe('setOverlayStyle', () => {
  it('changes only what it is given', () => {
    const styled = only(
      setOverlayStyle(withOverlay(), {
        overlayId: 'text-1',
        content: 'Changed',
        color: '#ff0000',
      }),
    )

    expect(styled.content).toBe('Changed')
    expect(styled.color).toBe('#ff0000')
    expect(styled.x).toBe(40)
    expect(styled.sizePx).toBe(32)
    expect(styled.timelineStartMicros).toBe(1 * SECOND)
  })

  it('rounds positions and refuses a size of nothing', () => {
    const styled = only(
      setOverlayStyle(withOverlay(), { overlayId: 'text-1', x: 10.6, y: 20.4 }),
    )
    expect(styled.x).toBe(11)
    expect(styled.y).toBe(20)

    expect(() =>
      setOverlayStyle(withOverlay(), { overlayId: 'text-1', sizePx: 0 }),
    ).toThrow(/positive size/)
  })
})

describe('removeOverlay', () => {
  it('removes it and reports an unknown id', () => {
    expect(removeOverlay(withOverlay(), 'text-1').overlays).toEqual([])
    expect(() => removeOverlay(withOverlay(), 'nope')).toThrow(/No overlay/)
  })
})

describe('timelineDuration with overlays', () => {
  it('runs to the end of an overlay past the last clip', () => {
    // An overlay hanging off the end still has to be playable.
    expect(timelineDuration(withOverlay())).toBe(3 * SECOND)
  })

  it('is still zero for an empty project', () => {
    expect(timelineDuration(emptyProject())).toBe(0)
  })
})

describe('overlay state shape', () => {
  it('stays plain JSON', () => {
    const project = setOverlayStyle(
      trimOverlayEnd(withOverlay(), {
        overlayId: 'text-1',
        timelineMicros: 2_500_000,
      }),
      { overlayId: 'text-1', content: 'x' },
    )

    expect(JSON.parse(JSON.stringify(project))).toEqual(project)
  })
})
