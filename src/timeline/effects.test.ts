import { describe, expect, it } from 'vitest'
import {
  addEffect,
  addEffectKeyframe,
  addSegment,
  addSource,
  moveEffect,
  removeEffect,
  removeEffectKeyframe,
  setEffectAmount,
} from './operations'
import {
  EFFECT_KINDS,
  MAIN_VIDEO_TRACK_ID,
  effectAmountAt,
  emptyProject,
  filterFor,
  findSegment,
  type Effect,
  type Project,
  type Source,
} from './types'

const SECOND = 1_000_000

const source: Source = {
  id: 'src-a',
  name: 'a.mp4',
  durationMicros: 10 * SECOND,
  width: 1920,
  height: 1080,
  rotation: 0,
}

function oneClip(): Project {
  return addSegment(addSource(emptyProject(), source), {
    trackId: MAIN_VIDEO_TRACK_ID,
    segment: {
      id: 'clip-1',
      timelineStartMicros: 0,
      content: {
        kind: 'video',
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: 4 * SECOND,
      },
    },
  })
}

function effectsOf(project: Project): Effect[] {
  return findSegment(project, 'clip-1')?.segment.effects ?? []
}

describe('filterFor', () => {
  it('is none for a segment with no effects', () => {
    expect(filterFor(undefined, 0)).toBe('none')
    expect(filterFor([], 0)).toBe('none')
  })

  it('is none while every effect sits at its neutral amount', () => {
    // This is what lets an effect be added without the picture moving.
    const neutral: Effect[] = [
      { id: 'a', kind: 'brightness', amount: 1 },
      { id: 'b', kind: 'blur', amount: 0 },
      { id: 'c', kind: 'grayscale', amount: 0 },
    ]

    expect(filterFor(neutral, 0)).toBe('none')
  })

  it('writes one filter function per effect that is doing something', () => {
    expect(
      filterFor(
        [
          { id: 'a', kind: 'brightness', amount: 1.5 },
          { id: 'b', kind: 'blur', amount: 4 },
        ],
        0,
      ),
    ).toBe('brightness(1.5) blur(4px)')
  })

  it('keeps the chain in order, because the order changes the result', () => {
    const a: Effect[] = [
      { id: 'a', kind: 'blur', amount: 2 },
      { id: 'b', kind: 'saturate', amount: 2 },
    ]
    const b = [a[1]!, a[0]!]

    expect(filterFor(a, 0)).toBe('blur(2px) saturate(2)')
    expect(filterFor(b, 0)).toBe('saturate(2) blur(2px)')
  })

  it('skips a neutral effect while keeping the rest', () => {
    expect(
      filterFor(
        [
          { id: 'a', kind: 'brightness', amount: 1 },
          { id: 'b', kind: 'contrast', amount: 2 },
        ],
        0,
      ),
    ).toBe('contrast(2)')
  })

  it('reads the animated amount at the offset it is given', () => {
    const animated: Effect[] = [
      {
        id: 'a',
        kind: 'brightness',
        amount: 1,
        keyframes: [
          { offsetMicros: 0, value: 1 },
          { offsetMicros: 2 * SECOND, value: 2 },
        ],
      },
    ]

    expect(filterFor(animated, 0)).toBe('none')
    expect(filterFor(animated, 1 * SECOND)).toBe('brightness(1.5)')
    expect(filterFor(animated, 9 * SECOND)).toBe('brightness(2)')
  })
})

describe('effectAmountAt', () => {
  it('is the fixed amount without a curve', () => {
    expect(
      effectAmountAt({ id: 'a', kind: 'contrast', amount: 1.4 }, 5 * SECOND),
    ).toBe(1.4)
  })

  it('clamps whatever the curve says into the kind range', () => {
    const effect: Effect = {
      id: 'a',
      kind: 'grayscale',
      amount: 0,
      keyframes: [
        { offsetMicros: 0, value: 0 },
        { offsetMicros: SECOND, value: 1 },
      ],
    }

    expect(effectAmountAt(effect, 99 * SECOND)).toBe(1)
    expect(effectAmountAt(effect, -99 * SECOND)).toBe(0)
  })
})

describe('addEffect', () => {
  it('lands at the neutral amount, so nothing changes on screen', () => {
    const project = addEffect(oneClip(), {
      segmentId: 'clip-1',
      id: 'fx-1',
      kind: 'brightness',
    })

    expect(effectsOf(project)).toEqual([
      { id: 'fx-1', kind: 'brightness', amount: EFFECT_KINDS.brightness.neutral },
    ])
    expect(filterFor(effectsOf(project), 0)).toBe('none')
  })

  it('appends by default and inserts at an index when asked', () => {
    let project = addEffect(oneClip(), {
      segmentId: 'clip-1',
      id: 'fx-1',
      kind: 'blur',
    })
    project = addEffect(project, {
      segmentId: 'clip-1',
      id: 'fx-2',
      kind: 'contrast',
    })
    expect(effectsOf(project).map((e) => e.id)).toEqual(['fx-1', 'fx-2'])

    project = addEffect(project, {
      segmentId: 'clip-1',
      id: 'fx-0',
      kind: 'saturate',
      index: 0,
    })
    expect(effectsOf(project).map((e) => e.id)).toEqual([
      'fx-0',
      'fx-1',
      'fx-2',
    ])
  })

  it('clamps an amount it is given', () => {
    const project = addEffect(oneClip(), {
      segmentId: 'clip-1',
      id: 'fx-1',
      kind: 'grayscale',
      amount: 5,
    })

    expect(effectsOf(project)[0]!.amount).toBe(1)
  })

  it('rejects a duplicate id, an unknown kind, or an unknown segment', () => {
    const project = addEffect(oneClip(), {
      segmentId: 'clip-1',
      id: 'fx-1',
      kind: 'blur',
    })

    expect(() =>
      addEffect(project, { segmentId: 'clip-1', id: 'fx-1', kind: 'blur' }),
    ).toThrow(/already exists/)

    expect(() =>
      addEffect(project, {
        segmentId: 'clip-1',
        id: 'fx-2',
        kind: 'nope' as never,
      }),
    ).toThrow(/Unknown effect kind/)

    expect(() =>
      addEffect(project, { segmentId: 'nope', id: 'fx-2', kind: 'blur' }),
    ).toThrow(/No segment/)
  })
})

describe('changing and removing effects', () => {
  function withBlur(): Project {
    return addEffect(oneClip(), {
      segmentId: 'clip-1',
      id: 'fx-1',
      kind: 'blur',
    })
  }

  it('sets an amount, clamped to the kind', () => {
    expect(
      effectsOf(
        setEffectAmount(withBlur(), {
          segmentId: 'clip-1',
          effectId: 'fx-1',
          amount: 8,
        }),
      )[0]!.amount,
    ).toBe(8)

    expect(
      effectsOf(
        setEffectAmount(withBlur(), {
          segmentId: 'clip-1',
          effectId: 'fx-1',
          amount: -4,
        }),
      )[0]!.amount,
    ).toBe(0)
  })

  it('rejects an amount that is not a number', () => {
    expect(() =>
      setEffectAmount(withBlur(), {
        segmentId: 'clip-1',
        effectId: 'fx-1',
        amount: Number.NaN,
      }),
    ).toThrow(/finite/)
  })

  it('removes an effect and ignores one that is not there', () => {
    expect(
      effectsOf(
        removeEffect(withBlur(), { segmentId: 'clip-1', effectId: 'fx-1' }),
      ),
    ).toEqual([])

    const project = withBlur()
    expect(
      removeEffect(project, { segmentId: 'clip-1', effectId: 'nope' }),
    ).toEqual(project)
  })

  it('reorders the chain', () => {
    let project = withBlur()
    project = addEffect(project, {
      segmentId: 'clip-1',
      id: 'fx-2',
      kind: 'contrast',
    })
    project = moveEffect(project, {
      segmentId: 'clip-1',
      effectId: 'fx-2',
      index: 0,
    })

    expect(effectsOf(project).map((e) => e.id)).toEqual(['fx-2', 'fx-1'])
  })

  it('reports an effect that is not there when reordering', () => {
    expect(() =>
      moveEffect(withBlur(), {
        segmentId: 'clip-1',
        effectId: 'nope',
        index: 0,
      }),
    ).toThrow(/No effect/)
  })
})

describe('animating an effect', () => {
  function withBrightness(): Project {
    return addEffect(oneClip(), {
      segmentId: 'clip-1',
      id: 'fx-1',
      kind: 'brightness',
    })
  }

  it('builds a sorted curve and replaces a point at the same offset', () => {
    let project = withBrightness()
    for (const [offsetMicros, value] of [
      [2 * SECOND, 2],
      [0, 1],
      [2 * SECOND, 3],
    ] as const) {
      project = addEffectKeyframe(project, {
        segmentId: 'clip-1',
        effectId: 'fx-1',
        offsetMicros,
        value,
      })
    }

    expect(effectsOf(project)[0]!.keyframes).toEqual([
      { offsetMicros: 0, value: 1 },
      { offsetMicros: 2 * SECOND, value: 3 },
    ])
  })

  it('refuses an offset before the head or a fractional one', () => {
    expect(() =>
      addEffectKeyframe(withBrightness(), {
        segmentId: 'clip-1',
        effectId: 'fx-1',
        offsetMicros: -1,
        value: 1,
      }),
    ).toThrow(/before the head/)

    expect(() =>
      addEffectKeyframe(withBrightness(), {
        segmentId: 'clip-1',
        effectId: 'fx-1',
        offsetMicros: 0.5,
        value: 1,
      }),
    ).toThrow(/integer/)
  })

  it('drops the curve once its last point goes', () => {
    let project = addEffectKeyframe(withBrightness(), {
      segmentId: 'clip-1',
      effectId: 'fx-1',
      offsetMicros: 0,
      value: 2,
    })
    project = removeEffectKeyframe(project, {
      segmentId: 'clip-1',
      effectId: 'fx-1',
      offsetMicros: 0,
    })

    expect(effectsOf(project)[0]!.keyframes).toBeUndefined()
  })

  it('reports an effect that is not there', () => {
    expect(() =>
      addEffectKeyframe(withBrightness(), {
        segmentId: 'clip-1',
        effectId: 'nope',
        offsetMicros: 0,
        value: 1,
      }),
    ).toThrow(/No effect/)
  })
})

describe('effect state shape', () => {
  it('stays plain JSON', () => {
    let project = addEffect(oneClip(), {
      segmentId: 'clip-1',
      id: 'fx-1',
      kind: 'saturate',
    })
    project = addEffectKeyframe(project, {
      segmentId: 'clip-1',
      effectId: 'fx-1',
      offsetMicros: 0,
      value: 2,
    })

    expect(JSON.parse(JSON.stringify(project))).toEqual(project)
  })
})
