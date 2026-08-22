import { describe, expect, it } from 'vitest'
import {
  EDGE_GRAB_PIXELS,
  applyDrag,
  clampClipStart,
  clipZoneAt,
  dragPreviewMicros,
  dragToOperation,
  legalStartRange,
} from './dragging'
import { addClip, addSource } from './operations'
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
  rotation: 0,
}

/** One clip: source 2s..5s, sitting at 1s on the timeline. */
function oneClip(): Project {
  return addClip(addSource(emptyProject(), source), {
    id: 'clip-1',
    sourceId: source.id,
    sourceInMicros: 2 * SECOND,
    sourceOutMicros: 5 * SECOND,
    timelineStartMicros: 1 * SECOND,
  })
}

/** Two clips with a gap: 0-2s and 5-7s. */
function twoClips(): Project {
  let project = addClip(addSource(emptyProject(), source), {
    id: 'left',
    sourceId: source.id,
    sourceInMicros: 0,
    sourceOutMicros: 2 * SECOND,
    timelineStartMicros: 0,
  })
  project = addClip(project, {
    id: 'right',
    sourceId: source.id,
    sourceInMicros: 0,
    sourceOutMicros: 2 * SECOND,
    timelineStartMicros: 5 * SECOND,
  })
  return project
}

function clipById(project: Project, id: string) {
  const clip = project.videoTrack.clips.find((candidate) => candidate.id === id)
  if (!clip) throw new Error(`test setup: no clip ${id}`)
  return clip
}

describe('clipZoneAt', () => {
  it('grabs the head within the edge margin', () => {
    expect(clipZoneAt(0, 200)).toBe('trim-start')
    expect(clipZoneAt(EDGE_GRAB_PIXELS, 200)).toBe('trim-start')
  })

  it('grabs the tail within the edge margin', () => {
    expect(clipZoneAt(200, 200)).toBe('trim-end')
    expect(clipZoneAt(200 - EDGE_GRAB_PIXELS, 200)).toBe('trim-end')
  })

  it('moves the clip anywhere in between', () => {
    expect(clipZoneAt(EDGE_GRAB_PIXELS + 1, 200)).toBe('move')
    expect(clipZoneAt(100, 200)).toBe('move')
    expect(clipZoneAt(200 - EDGE_GRAB_PIXELS - 1, 200)).toBe('move')
  })

  it('is all edges on a clip too narrow to have a middle', () => {
    // Otherwise a very short clip could never be trimmed back open.
    expect(clipZoneAt(1, 8)).toBe('trim-start')
    expect(clipZoneAt(7, 8)).toBe('trim-end')
  })
})

describe('legalStartRange', () => {
  it('runs from zero to forever for a lone clip', () => {
    const range = legalStartRange(oneClip(), 'clip-1')

    expect(range.minMicros).toBe(0)
    expect(range.maxMicros).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('stops at the neighbours on both sides', () => {
    let project = twoClips()
    project = addClip(project, {
      id: 'middle',
      sourceId: source.id,
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
})

describe('clampClipStart', () => {
  it('stops at a neighbour rather than overlapping it', () => {
    expect(clampClipStart(twoClips(), 'right', 0)).toBe(2 * SECOND)
  })

  it('never goes before the start of the timeline', () => {
    expect(clampClipStart(oneClip(), 'clip-1', -5 * SECOND)).toBe(0)
  })

  it('leaves a legal position alone', () => {
    expect(clampClipStart(twoClips(), 'right', 3 * SECOND)).toBe(3 * SECOND)
  })
})

describe('dragToOperation', () => {
  it('turns a sideways drag into a move', () => {
    const operation = dragToOperation(oneClip(), {
      clipId: 'clip-1',
      mode: 'move',
      deltaMicros: 2 * SECOND,
    })

    expect(operation).toEqual({
      kind: 'move',
      input: { clipId: 'clip-1', timelineStartMicros: 3 * SECOND },
    })
  })

  it('clamps a move into a neighbour', () => {
    const operation = dragToOperation(twoClips(), {
      clipId: 'right',
      mode: 'move',
      deltaMicros: -5 * SECOND,
    })

    expect(operation).toEqual({
      kind: 'move',
      input: { clipId: 'right', timelineStartMicros: 2 * SECOND },
    })
  })

  it('is nothing at all when the clip would not move', () => {
    expect(
      dragToOperation(oneClip(), {
        clipId: 'clip-1',
        mode: 'move',
        deltaMicros: 0,
      }),
    ).toBeNull()

    // Already hard against a neighbour: dragging further is not an edit.
    expect(
      dragToOperation(twoClips(), {
        clipId: 'left',
        mode: 'move',
        deltaMicros: -SECOND,
      }),
    ).toBeNull()
  })

  it('turns an edge drag into the matching trim', () => {
    expect(
      dragToOperation(oneClip(), {
        clipId: 'clip-1',
        mode: 'trim-start',
        deltaMicros: 500_000,
      }),
    ).toEqual({
      kind: 'trim-start',
      input: { clipId: 'clip-1', timelineMicros: 1_500_000 },
    })

    expect(
      dragToOperation(oneClip(), {
        clipId: 'clip-1',
        mode: 'trim-end',
        deltaMicros: -500_000,
      }),
    ).toEqual({
      kind: 'trim-end',
      input: { clipId: 'clip-1', timelineMicros: 3_500_000 },
    })
  })

  it('is nothing for a clip that is not there', () => {
    expect(
      dragToOperation(oneClip(), {
        clipId: 'ghost',
        mode: 'move',
        deltaMicros: SECOND,
      }),
    ).toBeNull()
  })
})

describe('applyDrag', () => {
  it('moves a clip without touching its source range', () => {
    const before = clipById(oneClip(), 'clip-1')
    const after = clipById(
      applyDrag(oneClip(), {
        clipId: 'clip-1',
        mode: 'move',
        deltaMicros: 2 * SECOND,
      }),
      'clip-1',
    )

    expect(after.timelineStartMicros).toBe(3 * SECOND)
    expect(after.sourceInMicros).toBe(before.sourceInMicros)
    expect(after.sourceOutMicros).toBe(before.sourceOutMicros)
  })

  it('head trim moves the source in-point with the head', () => {
    const after = clipById(
      applyDrag(oneClip(), {
        clipId: 'clip-1',
        mode: 'trim-start',
        deltaMicros: SECOND,
      }),
      'clip-1',
    )

    expect(after.timelineStartMicros).toBe(2 * SECOND)
    expect(after.sourceInMicros).toBe(3 * SECOND)
    expect(after.sourceOutMicros).toBe(5 * SECOND)
  })

  it('tail trim moves the out-point only', () => {
    const after = clipById(
      applyDrag(oneClip(), {
        clipId: 'clip-1',
        mode: 'trim-end',
        deltaMicros: -SECOND,
      }),
      'clip-1',
    )

    expect(after.timelineStartMicros).toBe(1 * SECOND)
    expect(after.sourceInMicros).toBe(2 * SECOND)
    expect(after.sourceOutMicros).toBe(4 * SECOND)
  })

  it('returns the project untouched when the gesture is a no-op', () => {
    const project = oneClip()

    expect(
      applyDrag(project, {
        clipId: 'clip-1',
        mode: 'move',
        deltaMicros: 0,
      }),
    ).toBe(project)
  })

  it('never throws, however absurd the gesture', () => {
    const project = twoClips()

    for (const deltaMicros of [-99 * SECOND, 99 * SECOND]) {
      for (const mode of ['move', 'trim-start', 'trim-end'] as const) {
        for (const clipId of ['left', 'right']) {
          const after = applyDrag(project, { clipId, mode, deltaMicros })

          // Whatever happened, the result is still a valid timeline.
          const clips = after.videoTrack.clips
          for (let i = 0; i < clips.length; i++) {
            expect(clipDuration(clips[i]!)).toBeGreaterThan(0)
            if (i > 0) {
              expect(clips[i]!.timelineStartMicros).toBeGreaterThanOrEqual(
                clipEndMicros(clips[i - 1]!),
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
      clipId: 'clip-1',
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
        clipId: 'clip-1',
        mode: 'move',
        deltaMicros: 0,
      }),
    ).toBe(1 * SECOND)
    expect(
      dragPreviewMicros(project, {
        clipId: 'clip-1',
        mode: 'trim-start',
        deltaMicros: 0,
      }),
    ).toBe(1 * SECOND)
  })

  it('parks just inside the tail while tail-trimming', () => {
    // The tail is exclusive, so the last visible frame is one microsecond in.
    expect(
      dragPreviewMicros(oneClip(), {
        clipId: 'clip-1',
        mode: 'trim-end',
        deltaMicros: 0,
      }),
    ).toBe(4 * SECOND - 1)
  })

  it('is nothing for a clip that is not there', () => {
    expect(
      dragPreviewMicros(oneClip(), {
        clipId: 'ghost',
        mode: 'move',
        deltaMicros: 0,
      }),
    ).toBeNull()
  })
})
