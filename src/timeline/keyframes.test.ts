import { describe, expect, it } from 'vitest'
import {
  addKeyframe,
  addSegment,
  addSource,
  addTrack,
  clearKeyframes,
  moveSegment,
  removeKeyframe,
  setSegmentProperties,
  trimSegmentStart,
  visibleVideoSegmentsAt,
} from './operations'
import {
  IDENTITY_TRANSFORM,
  MAIN_TEXT_TRACK_ID,
  MAIN_VIDEO_TRACK_ID,
  emptyProject,
  findSegment,
  isAnimated,
  transformAt,
  valueAt,
  type Project,
  type Segment,
  type Source,
} from './types'

const SECOND = 1_000_000

/** 320x240, the same shape as the default composition would be set to. */
const source: Source = {
  id: 'src-a',
  name: 'a.mp4',
  durationMicros: 10 * SECOND,
  width: 1920,
  height: 1080,
  rotation: 0,
}

/** A second source of a DIFFERENT shape, so it letterboxes. */
const wideSource: Source = {
  ...source,
  id: 'src-wide',
  width: 1920,
  height: 800,
}

/** One video segment at 1s..3s on the main row, in a 1920x1080 composition. */
function oneClip(): Project {
  const project = addSource(addSource(emptyProject(), source), wideSource)
  return addSegment(project, {
    trackId: MAIN_VIDEO_TRACK_ID,
    segment: {
      id: 'clip-1',
      timelineStartMicros: 1 * SECOND,
      content: {
        kind: 'video',
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: 2 * SECOND,
      },
    },
  })
}

function segmentById(project: Project, id: string): Segment {
  const found = findSegment(project, id)
  if (!found) throw new Error(`test setup: no segment ${id}`)
  return found.segment
}

describe('valueAt', () => {
  const curve = [
    { offsetMicros: 0, value: 0 },
    { offsetMicros: 1 * SECOND, value: 10 },
    { offsetMicros: 3 * SECOND, value: 30 },
  ]

  it('falls back when there is no curve at all', () => {
    expect(valueAt([], 500, 7)).toBe(7)
  })

  it('lands exactly on a keyframe', () => {
    expect(valueAt(curve, 0, -1)).toBe(0)
    expect(valueAt(curve, 1 * SECOND, -1)).toBe(10)
    expect(valueAt(curve, 3 * SECOND, -1)).toBe(30)
  })

  it('interpolates linearly in between', () => {
    expect(valueAt(curve, 500_000, -1)).toBe(5)
    expect(valueAt(curve, 2 * SECOND, -1)).toBe(20)
  })

  it('holds the nearest keyframe outside the curve rather than extrapolating', () => {
    expect(valueAt(curve, -9 * SECOND, -1)).toBe(0)
    expect(valueAt(curve, 99 * SECOND, -1)).toBe(30)
  })

  it('takes the later keyframe when two share an offset', () => {
    const doubled = [
      { offsetMicros: 0, value: 1 },
      { offsetMicros: SECOND, value: 2 },
      { offsetMicros: SECOND, value: 3 },
      { offsetMicros: 2 * SECOND, value: 4 },
    ]

    expect(valueAt(doubled, SECOND, -1)).toBe(2)
    expect(valueAt(doubled, 1_500_000, -1)).toBe(3.5)
  })
})

describe('transformAt', () => {
  it('is identity for a segment that has never been transformed', () => {
    expect(transformAt(segmentById(oneClip(), 'clip-1'), 1 * SECOND)).toEqual(
      IDENTITY_TRANSFORM,
    )
  })

  it('uses the fixed transform where there is no animation', () => {
    const project = setSegmentProperties(oneClip(), {
      segmentId: 'clip-1',
      scale: 0.5,
      x: 40,
    })

    expect(transformAt(segmentById(project, 'clip-1'), 2 * SECOND)).toEqual({
      scale: 0.5,
      x: 40,
      y: 0,
      rotation: 0,
      opacity: 1,
    })
  })

  it('lets an animated property override the fixed one', () => {
    let project = setSegmentProperties(oneClip(), {
      segmentId: 'clip-1',
      scale: 0.5,
      opacity: 0.25,
    })
    project = addKeyframe(project, {
      segmentId: 'clip-1',
      property: 'scale',
      offsetMicros: 0,
      value: 1,
    })
    project = addKeyframe(project, {
      segmentId: 'clip-1',
      property: 'scale',
      offsetMicros: 2 * SECOND,
      value: 3,
    })

    const segment = segmentById(project, 'clip-1')

    // Offsets are from the segment head, which is at 1s on the timeline.
    expect(transformAt(segment, 1 * SECOND).scale).toBe(1)
    expect(transformAt(segment, 2 * SECOND).scale).toBe(2)
    expect(transformAt(segment, 3 * SECOND).scale).toBe(3)
    // The property with no keyframes keeps the fixed value throughout.
    expect(transformAt(segment, 2 * SECOND).opacity).toBe(0.25)
  })

  it('carries its animation when the segment moves', () => {
    let project = addKeyframe(oneClip(), {
      segmentId: 'clip-1',
      property: 'opacity',
      offsetMicros: 0,
      value: 0,
    })
    project = addKeyframe(project, {
      segmentId: 'clip-1',
      property: 'opacity',
      offsetMicros: 2 * SECOND,
      value: 1,
    })

    const before = transformAt(segmentById(project, 'clip-1'), 2 * SECOND)
    expect(before.opacity).toBe(0.5)

    // Sliding the segment four seconds later moves the fade with it: the
    // offsets are relative to the head, not to the timeline.
    const moved = moveSegment(project, {
      segmentId: 'clip-1',
      timelineStartMicros: 5 * SECOND,
    })
    expect(transformAt(segmentById(moved, 'clip-1'), 6 * SECOND).opacity).toBe(
      0.5,
    )
  })

  it('keeps the animation anchored to the head when the head is trimmed', () => {
    let project = addKeyframe(oneClip(), {
      segmentId: 'clip-1',
      property: 'opacity',
      offsetMicros: 0,
      value: 0,
    })
    project = addKeyframe(project, {
      segmentId: 'clip-1',
      property: 'opacity',
      offsetMicros: 2 * SECOND,
      value: 1,
    })

    // Trimming the head half a second in: the fade now starts there.
    project = trimSegmentStart(project, {
      segmentId: 'clip-1',
      timelineMicros: 1_500_000,
    })

    const segment = segmentById(project, 'clip-1')
    expect(segment.timelineStartMicros).toBe(1_500_000)
    expect(transformAt(segment, 1_500_000).opacity).toBe(0)
  })
})

describe('setSegmentTransform', () => {
  it('changes only the fields it is given', () => {
    let project = setSegmentProperties(oneClip(), {
      segmentId: 'clip-1',
      scale: 2,
    })
    project = setSegmentProperties(project, { segmentId: 'clip-1', x: 15 })

    expect(transformAt(segmentById(project, 'clip-1'), 1 * SECOND)).toEqual({
      scale: 2,
      x: 15,
      y: 0,
      rotation: 0,
      opacity: 1,
    })
  })

  it('clamps opacity to 0..1 and keeps scale above nothing', () => {
    const project = setSegmentProperties(oneClip(), {
      segmentId: 'clip-1',
      opacity: 4,
      scale: -3,
    })
    const transform = transformAt(segmentById(project, 'clip-1'), 1 * SECOND)

    expect(transform.opacity).toBe(1)
    expect(transform.scale).toBeGreaterThan(0)
  })

  it('rejects a value that is not a number', () => {
    expect(() =>
      setSegmentProperties(oneClip(), {
        segmentId: 'clip-1',
        scale: Number.NaN,
      }),
    ).toThrow(/finite/)
  })

  it('rejects an unknown segment', () => {
    expect(() =>
      setSegmentProperties(oneClip(), { segmentId: 'nope', scale: 1 }),
    ).toThrow(/No segment/)
  })
})

describe('addKeyframe', () => {
  it('keeps a curve sorted however it is built', () => {
    let project = oneClip()
    for (const offsetMicros of [2 * SECOND, 0, 1 * SECOND]) {
      project = addKeyframe(project, {
        segmentId: 'clip-1',
        property: 'x',
        offsetMicros,
        value: offsetMicros,
      })
    }

    expect(
      segmentById(project, 'clip-1').keyframes!.x!.map((k) => k.offsetMicros),
    ).toEqual([0, 1 * SECOND, 2 * SECOND])
  })

  it('replaces a keyframe already at that offset instead of doubling it', () => {
    let project = addKeyframe(oneClip(), {
      segmentId: 'clip-1',
      property: 'x',
      offsetMicros: SECOND,
      value: 10,
    })
    project = addKeyframe(project, {
      segmentId: 'clip-1',
      property: 'x',
      offsetMicros: SECOND,
      value: 99,
    })

    expect(segmentById(project, 'clip-1').keyframes!.x).toEqual([
      { offsetMicros: SECOND, value: 99 },
    ])
  })

  it('refuses an offset before the head or a fractional one', () => {
    expect(() =>
      addKeyframe(oneClip(), {
        segmentId: 'clip-1',
        property: 'x',
        offsetMicros: -1,
        value: 0,
      }),
    ).toThrow(/before the head/)

    expect(() =>
      addKeyframe(oneClip(), {
        segmentId: 'clip-1',
        property: 'x',
        offsetMicros: 1.5,
        value: 0,
      }),
    ).toThrow(/integer/)
  })

  it('clamps the value it stores, like the fixed transform does', () => {
    const project = addKeyframe(oneClip(), {
      segmentId: 'clip-1',
      property: 'opacity',
      offsetMicros: 0,
      value: 9,
    })

    expect(segmentById(project, 'clip-1').keyframes!.opacity).toEqual([
      { offsetMicros: 0, value: 1 },
    ])
  })
})

describe('removeKeyframe and clearKeyframes', () => {
  function twoKeyframes(): Project {
    let project = addKeyframe(oneClip(), {
      segmentId: 'clip-1',
      property: 'x',
      offsetMicros: 0,
      value: 0,
    })
    return addKeyframe(project, {
      segmentId: 'clip-1',
      property: 'x',
      offsetMicros: SECOND,
      value: 100,
    })
  }

  it('removes one point and leaves the rest', () => {
    const project = removeKeyframe(twoKeyframes(), {
      segmentId: 'clip-1',
      property: 'x',
      offsetMicros: 0,
    })

    expect(segmentById(project, 'clip-1').keyframes!.x).toEqual([
      { offsetMicros: SECOND, value: 100 },
    ])
  })

  it('drops the property entirely once its last point goes', () => {
    let project = twoKeyframes()
    project = removeKeyframe(project, {
      segmentId: 'clip-1',
      property: 'x',
      offsetMicros: 0,
    })
    project = removeKeyframe(project, {
      segmentId: 'clip-1',
      property: 'x',
      offsetMicros: SECOND,
    })

    expect(segmentById(project, 'clip-1').keyframes!.x).toBeUndefined()
    expect(isAnimated(segmentById(project, 'clip-1'))).toBe(false)
  })

  it('does nothing for a point that is not there', () => {
    const project = twoKeyframes()
    expect(
      removeKeyframe(project, {
        segmentId: 'clip-1',
        property: 'x',
        offsetMicros: 9 * SECOND,
      }),
    ).toEqual(project)
  })

  it('clears one property or all of them', () => {
    let project = twoKeyframes()
    project = addKeyframe(project, {
      segmentId: 'clip-1',
      property: 'y',
      offsetMicros: 0,
      value: 5,
    })

    expect(
      segmentById(clearKeyframes(project, {
        segmentId: 'clip-1',
        property: 'x',
      }), 'clip-1').keyframes!.y,
    ).toHaveLength(1)

    expect(
      isAnimated(
        segmentById(clearKeyframes(project, { segmentId: 'clip-1' }), 'clip-1'),
      ),
    ).toBe(false)
  })
})

describe('what a transform makes visible', () => {
  /** The gapped stack: clip-1 on the main row, an upper row over the top of it. */
  function stacked(): Project {
    let project = addTrack(oneClip(), { id: 'video-2', kind: 'video' })
    return addSegment(project, {
      trackId: 'video-2',
      segment: {
        id: 'upper',
        timelineStartMicros: 1 * SECOND,
        content: {
          kind: 'video',
          sourceId: source.id,
          sourceInMicros: 0,
          sourceOutMicros: 2 * SECOND,
        },
      },
    })
  }

  it('hides the row beneath while the upper one fills the frame', () => {
    // Same shape as the composition, untransformed: nothing shows through.
    expect(
      visibleVideoSegmentsAt(stacked(), 2 * SECOND).map((e) => e.segment.id),
    ).toEqual(['upper'])
  })

  it('reveals the row beneath as soon as the upper one is scaled down', () => {
    const project = setSegmentProperties(stacked(), {
      segmentId: 'upper',
      scale: 0.5,
    })

    expect(
      visibleVideoSegmentsAt(project, 2 * SECOND).map((e) => e.segment.id),
    ).toEqual(['clip-1', 'upper'])
  })

  it('reveals the row beneath as soon as the upper one is faded', () => {
    const project = setSegmentProperties(stacked(), {
      segmentId: 'upper',
      opacity: 0.5,
    })

    expect(
      visibleVideoSegmentsAt(project, 2 * SECOND).map((e) => e.segment.id),
    ).toEqual(['clip-1', 'upper'])
  })

  it('reveals the row beneath as soon as the upper one is moved', () => {
    const project = setSegmentProperties(stacked(), {
      segmentId: 'upper',
      y: 30,
    })

    expect(
      visibleVideoSegmentsAt(project, 2 * SECOND).map((e) => e.segment.id),
    ).toEqual(['clip-1', 'upper'])
  })

  it('follows the animation: hidden at one moment, revealed at the next', () => {
    let project = addKeyframe(stacked(), {
      segmentId: 'upper',
      property: 'scale',
      offsetMicros: 0,
      value: 1,
    })
    project = addKeyframe(project, {
      segmentId: 'upper',
      property: 'scale',
      offsetMicros: 2 * SECOND,
      value: 0.5,
    })

    // At the head the upper row still fills the frame.
    expect(
      visibleVideoSegmentsAt(project, 1 * SECOND).map((e) => e.segment.id),
    ).toEqual(['upper'])
    // Half a second later it has shrunk, so the row beneath has to be drawn.
    expect(
      visibleVideoSegmentsAt(project, 2 * SECOND).map((e) => e.segment.id),
    ).toEqual(['clip-1', 'upper'])
  })

  it('never hides anything behind a source that letterboxes', () => {
    let project = addTrack(oneClip(), { id: 'video-2', kind: 'video' })
    project = addSegment(project, {
      trackId: 'video-2',
      segment: {
        id: 'wide',
        timelineStartMicros: 1 * SECOND,
        content: {
          kind: 'video',
          sourceId: wideSource.id,
          sourceInMicros: 0,
          sourceOutMicros: 2 * SECOND,
        },
      },
    })

    // The bars beside a 1920x800 source in a 16:9 composition are holes, and
    // what is under them has to be drawn.
    expect(
      visibleVideoSegmentsAt(project, 2 * SECOND).map((e) => e.segment.id),
    ).toEqual(['clip-1', 'wide'])
  })

  it('is plain JSON once animated, like everything else', () => {
    const project = addKeyframe(
      setSegmentProperties(oneClip(), { segmentId: 'clip-1', scale: 2 }),
      {
        segmentId: 'clip-1',
        property: 'scale',
        offsetMicros: 0,
        value: 1,
      },
    )

    expect(JSON.parse(JSON.stringify(project))).toEqual(project)
  })
})

describe('text is animated the same way', () => {
  it('animates a caption without any special case', () => {
    let project = addSegment(emptyProject(), {
      trackId: MAIN_TEXT_TRACK_ID,
      segment: {
        id: 'text-1',
        timelineStartMicros: 0,
        content: {
          kind: 'text',
          content: 'Hello',
          x: 10,
          y: 20,
          sizePx: 32,
          color: '#ffffff',
          durationMicros: 2 * SECOND,
        },
      },
    })
    project = addKeyframe(project, {
      segmentId: 'text-1',
      property: 'y',
      offsetMicros: 0,
      value: 0,
    })
    project = addKeyframe(project, {
      segmentId: 'text-1',
      property: 'y',
      offsetMicros: 2 * SECOND,
      value: 200,
    })

    expect(transformAt(segmentById(project, 'text-1'), SECOND).y).toBe(100)
  })
})

describe('rotation', () => {
  it('is nothing at all unless somebody asks for it', () => {
    // An identity transform has to stay identity, or the golden-frame
    // comparison between preview and export stops meaning anything.
    expect(transformAt(segmentById(oneClip(), 'clip-1'), 1 * SECOND).rotation)
      .toBe(0)
  })

  it('is a plain property, so it keyframes like the rest', () => {
    let project = oneClip()
    project = addKeyframe(project, {
      segmentId: 'clip-1',
      property: 'rotation',
      offsetMicros: 0,
      value: 0,
    })
    project = addKeyframe(project, {
      segmentId: 'clip-1',
      property: 'rotation',
      offsetMicros: 2 * SECOND,
      value: 180,
    })

    // Offsets are from the segment head, which is at 1s on the timeline.
    const at = (micros: number) =>
      transformAt(segmentById(project, 'clip-1'), micros).rotation

    expect(at(1 * SECOND)).toBe(0)
    expect(at(2 * SECOND)).toBe(90)
    expect(at(3 * SECOND)).toBe(180)
  })

  it('is clamped to a single turn either way', () => {
    // Wider would only ever mean the same picture, and a spin of more than one
    // turn is several keyframes rather than a bigger number.
    let project = setSegmentProperties(oneClip(), {
      segmentId: 'clip-1',
      rotation: 900,
    })
    expect(transformAt(segmentById(project, 'clip-1'), 0).rotation).toBe(360)

    project = setSegmentProperties(oneClip(), {
      segmentId: 'clip-1',
      rotation: -900,
    })
    expect(transformAt(segmentById(project, 'clip-1'), 0).rotation).toBe(-360)
  })
})
