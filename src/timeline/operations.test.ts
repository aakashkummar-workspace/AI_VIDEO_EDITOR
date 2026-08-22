import { describe, expect, it } from 'vitest'
import {
  addClip,
  addSource,
  clipAt,
  moveClip,
  removeClip,
  splitClipAt,
  timelineDuration,
  trimClipEnd,
  trimClipStart,
} from './operations'
import {
  clipDuration,
  clipEndMicros,
  emptyProject,
  type Project,
  type Source,
} from './types'

const SECOND = 1_000_000

const source: Source = {
  id: 'src-a',
  name: 'a.mp4',
  durationMicros: 10 * SECOND,
  width: 320,
  height: 240,
}

const otherSource: Source = { ...source, id: 'src-b', name: 'b.mp4' }

function projectWithSources(): Project {
  return addSource(addSource(emptyProject(), source), otherSource)
}

/** A project holding one clip: source 1s..3s, sitting at 0s on the timeline. */
function oneClip(): Project {
  return addClip(projectWithSources(), {
    id: 'clip-1',
    sourceId: source.id,
    sourceInMicros: 1 * SECOND,
    sourceOutMicros: 3 * SECOND,
    timelineStartMicros: 0,
  })
}

function clips(project: Project) {
  return project.videoTrack.clips
}

function clipById(project: Project, id: string) {
  const clip = clips(project).find((candidate) => candidate.id === id)
  if (!clip) throw new Error(`test setup: no clip ${id}`)
  return clip
}

describe('addClip', () => {
  it('adds a clip whose duration is derived, not stored', () => {
    const project = oneClip()
    const clip = clipById(project, 'clip-1')

    expect(clips(project)).toHaveLength(1)
    expect(clipDuration(clip)).toBe(2 * SECOND)
    expect(Object.keys(clip).sort()).toEqual([
      'id',
      'sourceId',
      'sourceInMicros',
      'sourceOutMicros',
      'timelineStartMicros',
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

  it('keeps clips sorted by timeline start', () => {
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

  it('rejects a clip that would overlap another', () => {
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

  it('allows a clip that starts exactly where another ends', () => {
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

  it('rejects a zero-length clip', () => {
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
})

describe('removeClip', () => {
  it('removes the clip and leaves the gap', () => {
    let project = addClip(oneClip(), {
      id: 'clip-2',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: SECOND,
      timelineStartMicros: 5 * SECOND,
    })
    project = removeClip(project, 'clip-1')

    expect(clips(project).map((clip) => clip.id)).toEqual(['clip-2'])
    expect(clipById(project, 'clip-2').timelineStartMicros).toBe(5 * SECOND)
  })

  it('rejects an unknown clip', () => {
    expect(() => removeClip(oneClip(), 'nope')).toThrow(/No clip/)
  })
})

describe('moveClip', () => {
  it('moves a clip without changing its source range', () => {
    const before = clipById(oneClip(), 'clip-1')
    const project = moveClip(oneClip(), {
      clipId: 'clip-1',
      timelineStartMicros: 5 * SECOND,
    })
    const after = clipById(project, 'clip-1')

    expect(after.timelineStartMicros).toBe(5 * SECOND)
    expect(after.sourceInMicros).toBe(before.sourceInMicros)
    expect(after.sourceOutMicros).toBe(before.sourceOutMicros)
  })

  it('re-sorts when a clip moves past another', () => {
    const project = moveClip(
      addClip(oneClip(), {
        id: 'clip-2',
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: SECOND,
        timelineStartMicros: 5 * SECOND,
      }),
      { clipId: 'clip-1', timelineStartMicros: 7 * SECOND },
    )

    expect(clips(project).map((clip) => clip.id)).toEqual(['clip-2', 'clip-1'])
  })

  it('rejects a move that would overlap', () => {
    const project = addClip(oneClip(), {
      id: 'clip-2',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 5 * SECOND,
    })

    expect(() =>
      moveClip(project, { clipId: 'clip-2', timelineStartMicros: SECOND }),
    ).toThrow(/overlap/)
  })

  it('rejects a negative timeline start', () => {
    expect(() =>
      moveClip(oneClip(), { clipId: 'clip-1', timelineStartMicros: -1 }),
    ).toThrow(/before the beginning/)
  })
})

describe('trimClipStart', () => {
  it('moves the head and the source in-point together', () => {
    const project = trimClipStart(oneClip(), {
      clipId: 'clip-1',
      timelineMicros: 500_000,
    })
    const clip = clipById(project, 'clip-1')

    expect(clip.timelineStartMicros).toBe(500_000)
    expect(clip.sourceInMicros).toBe(1_500_000)
    expect(clip.sourceOutMicros).toBe(3 * SECOND)
    expect(clipDuration(clip)).toBe(1_500_000)
  })

  it('clamps to the start of the source when dragged too far left', () => {
    // The clip starts 1s into the source, so it can only extend 1s leftward.
    const project = trimClipStart(
      moveClip(oneClip(), { clipId: 'clip-1', timelineStartMicros: 5 * SECOND }),
      { clipId: 'clip-1', timelineMicros: 0 },
    )
    const clip = clipById(project, 'clip-1')

    expect(clip.sourceInMicros).toBe(0)
    expect(clip.timelineStartMicros).toBe(4 * SECOND)
  })

  it('never produces a zero or negative duration', () => {
    const project = trimClipStart(oneClip(), {
      clipId: 'clip-1',
      timelineMicros: 99 * SECOND,
    })
    const clip = clipById(project, 'clip-1')

    expect(clipDuration(clip)).toBe(1)
    expect(clip.sourceOutMicros).toBe(3 * SECOND)
  })

  it('clamps to the end of the previous clip', () => {
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

    project = trimClipStart(project, { clipId: 'second', timelineMicros: 0 })
    const clip = clipById(project, 'second')

    expect(clip.timelineStartMicros).toBe(2 * SECOND)
    expect(clip.sourceInMicros).toBe(3 * SECOND)
    expect(clips(project)[0]!.id).toBe('first')
  })
})

describe('trimClipEnd', () => {
  it('shortens the clip from the tail', () => {
    const project = trimClipEnd(oneClip(), {
      clipId: 'clip-1',
      timelineMicros: SECOND,
    })
    const clip = clipById(project, 'clip-1')

    expect(clip.timelineStartMicros).toBe(0)
    expect(clip.sourceInMicros).toBe(SECOND)
    expect(clip.sourceOutMicros).toBe(2 * SECOND)
  })

  it('clamps to the real end of the source', () => {
    // The clip starts 1s into a 10s source, so it can reach at most 9s long.
    const project = trimClipEnd(oneClip(), {
      clipId: 'clip-1',
      timelineMicros: 99 * SECOND,
    })
    const clip = clipById(project, 'clip-1')

    expect(clip.sourceOutMicros).toBe(source.durationMicros)
    expect(clipEndMicros(clip)).toBe(9 * SECOND)
  })

  it('never produces a zero or negative duration', () => {
    const project = trimClipEnd(oneClip(), {
      clipId: 'clip-1',
      timelineMicros: -5 * SECOND,
    })

    expect(clipDuration(clipById(project, 'clip-1'))).toBe(1)
  })

  it('clamps to the start of the next clip', () => {
    const project = trimClipEnd(
      addClip(oneClip(), {
        id: 'clip-2',
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: SECOND,
        timelineStartMicros: 4 * SECOND,
      }),
      { clipId: 'clip-1', timelineMicros: 8 * SECOND },
    )

    expect(clipEndMicros(clipById(project, 'clip-1'))).toBe(4 * SECOND)
  })
})

describe('splitClipAt', () => {
  it('cuts one clip into two touching halves', () => {
    const project = splitClipAt(oneClip(), {
      timelineMicros: 500_000,
      newClipId: 'clip-1b',
    })
    const [first, second] = clips(project)

    expect(clips(project)).toHaveLength(2)
    expect(first).toEqual({
      id: 'clip-1',
      sourceId: source.id,
      sourceInMicros: SECOND,
      sourceOutMicros: 1_500_000,
      timelineStartMicros: 0,
    })
    expect(second).toEqual({
      id: 'clip-1b',
      sourceId: source.id,
      sourceInMicros: 1_500_000,
      sourceOutMicros: 3 * SECOND,
      timelineStartMicros: 500_000,
    })
    expect(clipEndMicros(first!)).toBe(second!.timelineStartMicros)
  })

  it('preserves total duration', () => {
    const before = timelineDuration(oneClip())
    const after = timelineDuration(
      splitClipAt(oneClip(), {
        timelineMicros: 700_000,
        newClipId: 'clip-1b',
      }),
    )

    expect(after).toBe(before)
  })

  it('does nothing in empty space', () => {
    const project = oneClip()
    expect(
      splitClipAt(project, { timelineMicros: 5 * SECOND, newClipId: 'x' }),
    ).toEqual(project)
  })

  it('does nothing on a clip boundary, so no empty half is created', () => {
    const project = oneClip()

    expect(
      splitClipAt(project, { timelineMicros: 0, newClipId: 'x' }),
    ).toEqual(project)
    expect(
      splitClipAt(project, { timelineMicros: 2 * SECOND, newClipId: 'x' }),
    ).toEqual(project)
  })
})

describe('timelineDuration', () => {
  it('is zero for an empty timeline', () => {
    expect(timelineDuration(emptyProject())).toBe(0)
  })

  it('is the end of the last clip, gaps included', () => {
    const project = addClip(oneClip(), {
      id: 'clip-2',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: SECOND,
      timelineStartMicros: 5 * SECOND,
    })

    expect(timelineDuration(project)).toBe(6 * SECOND)
  })
})

describe('clipAt', () => {
  it('maps a timeline position to a source position', () => {
    const found = clipAt(oneClip(), 500_000)

    expect(found?.clip.id).toBe('clip-1')
    expect(found?.sourceMicros).toBe(1_500_000)
  })

  it('includes the first microsecond and excludes the last', () => {
    const project = oneClip()

    expect(clipAt(project, 0)?.sourceMicros).toBe(SECOND)
    expect(clipAt(project, 2 * SECOND - 1)?.sourceMicros).toBe(3 * SECOND - 1)
    expect(clipAt(project, 2 * SECOND)).toBeNull()
  })

  it('returns null over a gap', () => {
    const project = addClip(oneClip(), {
      id: 'clip-2',
      sourceId: source.id,
      sourceInMicros: 0,
      sourceOutMicros: SECOND,
      timelineStartMicros: 5 * SECOND,
    })

    expect(clipAt(project, 3 * SECOND)).toBeNull()
    expect(clipAt(project, 5 * SECOND)?.clip.id).toBe('clip-2')
  })

  it('picks the right clip either side of a split', () => {
    const project = splitClipAt(oneClip(), {
      timelineMicros: SECOND,
      newClipId: 'clip-1b',
    })

    expect(clipAt(project, SECOND - 1)?.clip.id).toBe('clip-1')
    expect(clipAt(project, SECOND)?.clip.id).toBe('clip-1b')
    // The cut is seamless: the source position runs on unbroken across it.
    expect(clipAt(project, SECOND - 1)?.sourceMicros).toBe(2 * SECOND - 1)
    expect(clipAt(project, SECOND)?.sourceMicros).toBe(2 * SECOND)
  })
})

describe('state shape', () => {
  it('stays plain JSON through every operation', () => {
    let project = oneClip()
    project = splitClipAt(project, {
      timelineMicros: SECOND,
      newClipId: 'clip-1b',
    })
    project = trimClipEnd(project, {
      clipId: 'clip-1b',
      timelineMicros: 1_800_000,
    })
    project = moveClip(project, {
      clipId: 'clip-1b',
      timelineStartMicros: 4 * SECOND,
    })

    expect(JSON.parse(JSON.stringify(project))).toEqual(project)
  })

  it('keeps every time value an integer', () => {
    const project = trimClipStart(
      splitClipAt(oneClip(), {
        timelineMicros: 999_999,
        newClipId: 'clip-1b',
      }),
      { clipId: 'clip-1b', timelineMicros: 1_400_001 },
    )

    for (const clip of clips(project)) {
      expect(Number.isInteger(clip.sourceInMicros)).toBe(true)
      expect(Number.isInteger(clip.sourceOutMicros)).toBe(true)
      expect(Number.isInteger(clip.timelineStartMicros)).toBe(true)
    }
  })

  it('never leaves clips overlapping or out of order', () => {
    let project = oneClip()
    project = addClip(project, {
      id: 'clip-2',
      sourceId: otherSource.id,
      sourceInMicros: 0,
      sourceOutMicros: 2 * SECOND,
      timelineStartMicros: 3 * SECOND,
    })
    project = splitClipAt(project, {
      timelineMicros: 4 * SECOND,
      newClipId: 'clip-2b',
    })
    project = trimClipStart(project, {
      clipId: 'clip-2',
      timelineMicros: 3_500_000,
    })

    const ordered = clips(project)
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]!.timelineStartMicros).toBeGreaterThanOrEqual(
        clipEndMicros(ordered[i - 1]!),
      )
    }
  })
})
