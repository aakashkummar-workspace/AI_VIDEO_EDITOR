import { describe, expect, it } from 'vitest'
import { dispatch, jsonSchemaFor, TOOL_DEFINITIONS, TOOL_SPECS } from './tools'
import { addSegment, addSource, mutators } from '../timeline/operations'
import {
  MAIN_TEXT_TRACK_ID,
  MAIN_VIDEO_TRACK_ID,
  emptyProject,
  findSegment,
  segmentDuration,
  segmentEndMicros,
  type Project,
  type Source,
  type TextContent,
} from '../timeline/types'

const SECOND = 1_000_000

const source: Source = {
  id: 'src-a',
  name: 'a.mp4',
  durationMicros: 10 * SECOND,
  width: 320,
  height: 240,
  rotation: 0,
}

/** One four second clip on the main video row, taken from the middle. */
function oneClip(): Project {
  return addSegment(addSource(emptyProject(), source), {
    trackId: MAIN_VIDEO_TRACK_ID,
    segment: {
      id: 'clip-1',
      timelineStartMicros: 0,
      content: {
        kind: 'video',
        sourceId: source.id,
        sourceInMicros: 1 * SECOND,
        sourceOutMicros: 5 * SECOND,
      },
    },
  })
}

function twoClips(): Project {
  return addSegment(oneClip(), {
    trackId: MAIN_VIDEO_TRACK_ID,
    segment: {
      id: 'clip-2',
      timelineStartMicros: 4 * SECOND,
      content: {
        kind: 'video',
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: 2 * SECOND,
      },
    },
  })
}

/** Deterministic ids, so a test can name the thing the dispatcher minted. */
function counter(prefix = 'new') {
  let next = 0
  return () => `${prefix}-${++next}`
}

describe('the tool schema', () => {
  it('names a real mutator for every tool', () => {
    // The schema is what the model is promised; the mutator is what actually
    // runs. A tool naming a mutator that has been renamed away would fail only
    // once somebody asked for that particular edit.
    for (const spec of TOOL_SPECS) {
      expect(typeof mutators[spec.mutator], spec.name).toBe('function')
    }
  })

  it('is derived from the specs, so the two cannot drift', () => {
    expect(TOOL_DEFINITIONS).toHaveLength(TOOL_SPECS.length)

    for (const definition of TOOL_DEFINITIONS) {
      const spec = TOOL_SPECS.find((entry) => entry.name === definition.name)
      expect(spec).toBeDefined()
      // Field by field through the one converter, rather than by identity:
      // `ranges` is expanded into a real array schema on the way out, so the
      // two are no longer the same object - but neither may drift from it.
      expect(Object.keys(definition.input_schema.properties)).toEqual(
        Object.keys(spec!.fields),
      )
      for (const [name, field] of Object.entries(spec!.fields)) {
        expect(definition.input_schema.properties[name], name).toEqual(
          jsonSchemaFor(field),
        )
      }
      expect(definition.input_schema.additionalProperties).toBe(false)
    }
  })

  it('never asks the model for an id it would have to invent', () => {
    // Ids are minted by the dispatcher. A model cannot see the ids already in
    // use, so one it made up would collide sooner or later.
    for (const definition of TOOL_DEFINITIONS) {
      const fields = Object.keys(definition.input_schema.properties)
      expect(fields, definition.name).not.toContain('newSegmentId')
      expect(fields, definition.name).not.toContain('id')
    }
  })

  it('requires every enum field to offer its values', () => {
    for (const spec of TOOL_SPECS) {
      for (const [name, field] of Object.entries(spec.fields)) {
        if (field.enum) {
          expect(field.enum.length, `${spec.name}.${name}`).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('dispatch', () => {
  it('turns seconds into whole microseconds', () => {
    const { project } = dispatch(
      oneClip(),
      'split_segment',
      { atSeconds: 1.5 },
      counter(),
    )

    const halves = project.tracks.find(
      (track) => track.id === MAIN_VIDEO_TRACK_ID,
    )!.segments
    expect(halves).toHaveLength(2)
    expect(halves[1]!.timelineStartMicros).toBe(1_500_000)
    expect(Number.isInteger(halves[1]!.timelineStartMicros)).toBe(true)
  })

  it('rounds a fractional microsecond rather than letting a float through', () => {
    // 0.0000005s is half a microsecond. Whatever it becomes, it must be whole -
    // an operation asserting integer microseconds would otherwise throw.
    const { step } = dispatch(
      oneClip(),
      'move_segment',
      { segmentId: 'clip-1', startSeconds: 1.0000005 },
      counter(),
    )

    const input = step.input as { timelineStartMicros: number }
    expect(Number.isInteger(input.timelineStartMicros)).toBe(true)
  })

  it('mints ids and ignores any the model tried to supply', () => {
    const { project, step } = dispatch(
      oneClip(),
      'duplicate_segment',
      { segmentId: 'clip-1', newSegmentId: 'clip-1' },
      counter('minted'),
    )

    expect((step.input as { newSegmentId: string }).newSegmentId).toBe('minted-1')
    expect(findSegment(project, 'minted-1')).toBeDefined()
  })

  it('leaves the project it was given untouched', () => {
    // The whole plan-then-approve flow rests on this: a run is worked out
    // against a scratch copy and the real store never sees it.
    const before = oneClip()
    const snapshot = JSON.stringify(before)

    dispatch(before, 'delete_segment', { segmentId: 'clip-1' }, counter())

    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('reports back what happened, not what was asked for', () => {
    // A trim clamps against running out of source rather than throwing, so the
    // summary has to be read out of the project afterwards.
    const { project, step } = dispatch(
      oneClip(),
      'trim_segment_end',
      { segmentId: 'clip-1', atSeconds: 90 },
      counter(),
    )

    const clip = findSegment(project, 'clip-1')!.segment
    expect(segmentEndMicros(clip)).toBeLessThan(90 * SECOND)
    expect(step.summary).toContain(
      `${(segmentEndMicros(clip) / SECOND).toFixed(3)}s`,
    )
  })

  it('writes a label a person can read, with no ids in it', () => {
    // The model needs ids to refer to what it has just made. A person reading a
    // plan does not, and a list of uuids is a plan nobody will actually check.
    const { step } = dispatch(
      oneClip(),
      'set_speed',
      { segmentId: 'clip-1', rate: 2 },
      counter(),
    )

    expect(step.label).toBe('Change the speed of "a.mp4" (0.000s-2.000s) to 2x')
    expect(step.label).not.toContain('clip-1')
  })

  it('names a caption by its words and a clip by its file', () => {
    const withText = dispatch(
      oneClip(),
      'add_text',
      { text: 'Chapter one', startSeconds: 0, durationSeconds: 2 },
      counter('cap'),
    )

    expect(withText.step.label).toContain('"Chapter one"')
    expect(withText.step.label).not.toContain('cap-1')
  })

  it('names a deleted segment from before it was deleted', () => {
    // Reading it out of the project afterwards would find nothing there.
    const { step } = dispatch(
      oneClip(),
      'delete_segment',
      { segmentId: 'clip-1' },
      counter(),
    )

    expect(step.label).toBe('Delete "a.mp4"')
  })

  it('names the new segment in the summary of a split', () => {
    const { step } = dispatch(
      oneClip(),
      'split_segment',
      { atSeconds: 2 },
      counter('half'),
    )

    expect(step.summary).toContain('half-1')
  })
})

describe('what dispatch refuses', () => {
  it('rejects a tool it does not have', () => {
    expect(() =>
      dispatch(oneClip(), 'render_masterpiece', {}, counter()),
    ).toThrow(/no tool called render_masterpiece/i)
  })

  it('rejects a value outside an enum, and says what was allowed', () => {
    expect(() =>
      dispatch(
        twoClips(),
        'add_transition',
        { segmentId: 'clip-2', kind: 'star-wipe', durationSeconds: 0.5 },
        counter(),
      ),
    ).toThrow(/crossfade/)
  })

  it('rejects a missing argument rather than guessing one', () => {
    expect(() =>
      dispatch(oneClip(), 'set_speed', { segmentId: 'clip-1' }, counter()),
    ).toThrow(/rate must be a finite number/)
  })

  it("passes an operation's own refusal straight through", () => {
    // These messages are written for people and read just as well to a model,
    // which is why nothing here rewrites them.
    expect(() =>
      dispatch(
        oneClip(),
        'add_transition',
        { segmentId: 'clip-1', kind: 'crossfade', durationSeconds: 0.5 },
        counter(),
      ),
    ).toThrow(/nothing before it to blend from/)
  })
})

describe('the edits themselves', () => {
  it('duplicates onto the end and pushes what followed along', () => {
    const { project } = dispatch(
      twoClips(),
      'duplicate_segment',
      { segmentId: 'clip-1' },
      counter('copy'),
    )

    const copy = findSegment(project, 'copy-1')!.segment
    expect(copy.timelineStartMicros).toBe(4 * SECOND)
    expect(findSegment(project, 'clip-2')!.segment.timelineStartMicros).toBe(
      8 * SECOND,
    )
  })

  it('puts a caption on the text row without being told which one', () => {
    const { project, step } = dispatch(
      oneClip(),
      'add_text',
      { text: 'hello', startSeconds: 1, durationSeconds: 2 },
      counter('cap'),
    )

    const found = findSegment(project, 'cap-1')!
    expect(found.track.id).toBe(MAIN_TEXT_TRACK_ID)
    expect((found.segment.content as TextContent).content).toBe('hello')
    expect(segmentDuration(found.segment)).toBe(2 * SECOND)
    expect(step.summary).toContain('cap-1')
  })

  it('sets only the properties it was given', () => {
    const { project } = dispatch(
      oneClip(),
      'set_properties',
      { segmentId: 'clip-1', opacity: 0.5 },
      counter(),
    )

    const clip = findSegment(project, 'clip-1')!.segment
    expect(clip.properties?.opacity).toBe(0.5)
    expect(clip.properties?.scale).toBeUndefined()
  })

  it('measures a keyframe from the segment head, not the timeline', () => {
    const moved = dispatch(
      oneClip(),
      'move_segment',
      { segmentId: 'clip-1', startSeconds: 5 },
      counter(),
    ).project

    const { project } = dispatch(
      moved,
      'add_keyframe',
      {
        segmentId: 'clip-1',
        property: 'opacity',
        offsetSeconds: 1,
        value: 0,
      },
      counter(),
    )

    const clip = findSegment(project, 'clip-1')!.segment
    expect(clip.keyframes?.opacity).toEqual([
      { offsetMicros: 1 * SECOND, value: 0 },
    ])
  })
})

describe('remove_spoken_ranges', () => {
  /** A clip playing the whole of a 60s source, sitting at the start. */
  function talk(): Project {
    const project = emptyProject()
    project.sources['src-a'] = {
      id: 'src-a',
      name: 'interview.mp4',
      durationMicros: 60 * SECOND,
      width: 1920,
      height: 1080,
      rotation: 0,
    }
    const video = project.tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)!
    video.segments.push({
      id: 'clip-1',
      timelineStartMicros: 0,
      content: {
        kind: 'video',
        sourceId: 'src-a',
        sourceInMicros: 0,
        sourceOutMicros: 60 * SECOND,
      },
    })
    return project
  }

  function videoSegments(project: Project) {
    return project.tracks
      .find((t) => t.id === MAIN_VIDEO_TRACK_ID)!
      .segments.map((segment) => ({
        at: segment.timelineStartMicros,
        from:
          segment.content.kind === 'video' ? segment.content.sourceInMicros : -1,
        to:
          segment.content.kind === 'video' ? segment.content.sourceOutMicros : -1,
      }))
  }

  it('cuts a stretch out and closes the gap', () => {
    // The whole point: the transcript says a line runs 10s to 20s, and cutting
    // it is quoting those numbers back. No conversion, no arithmetic.
    const { project } = dispatch(talk(), 'remove_spoken_ranges', {
      segmentId: 'clip-1',
      ranges: [{ fromSeconds: 10, toSeconds: 20 }],
    })

    expect(videoSegments(project)).toEqual([
      { at: 0, from: 0, to: 10 * SECOND },
      { at: 10 * SECOND, from: 20 * SECOND, to: 60 * SECOND },
    ])
  })

  it('takes every cut in one call, however they are ordered', () => {
    // One call rather than a run of splits and deletes is the entire reason
    // this tool exists: each split would move the ids and times of the next.
    const { project } = dispatch(talk(), 'remove_spoken_ranges', {
      segmentId: 'clip-1',
      ranges: [
        { fromSeconds: 40, toSeconds: 50 },
        { fromSeconds: 10, toSeconds: 20 },
      ],
    })

    expect(videoSegments(project)).toEqual([
      { at: 0, from: 0, to: 10 * SECOND },
      { at: 10 * SECOND, from: 20 * SECOND, to: 40 * SECOND },
      { at: 30 * SECOND, from: 50 * SECOND, to: 60 * SECOND },
    ])
  })

  it('merges ranges that overlap, which two transcript lines can', () => {
    const { project } = dispatch(talk(), 'remove_spoken_ranges', {
      segmentId: 'clip-1',
      ranges: [
        { fromSeconds: 10, toSeconds: 20 },
        { fromSeconds: 15, toSeconds: 25 },
      ],
    })

    expect(videoSegments(project)).toEqual([
      { at: 0, from: 0, to: 10 * SECOND },
      { at: 10 * SECOND, from: 25 * SECOND, to: 60 * SECOND },
    ])
  })

  it('cuts from the head and from the tail', () => {
    const { project } = dispatch(talk(), 'remove_spoken_ranges', {
      segmentId: 'clip-1',
      ranges: [
        { fromSeconds: 0, toSeconds: 5 },
        { fromSeconds: 55, toSeconds: 60 },
      ],
    })

    expect(videoSegments(project)).toEqual([
      { at: 0, from: 5 * SECOND, to: 55 * SECOND },
    ])
  })

  it('clamps a range reaching past what the clip plays', () => {
    // A transcript covers the whole FILE; a trimmed clip plays part of it. A
    // line running off the end is still a line to cut.
    const project = talk()
    const segment = project.tracks.find((t) => t.id === MAIN_VIDEO_TRACK_ID)!
      .segments[0]!
    segment.content = {
      kind: 'video',
      sourceId: 'src-a',
      sourceInMicros: 10 * SECOND,
      sourceOutMicros: 30 * SECOND,
    }

    const out = dispatch(project, 'remove_spoken_ranges', {
      segmentId: 'clip-1',
      ranges: [{ fromSeconds: 25, toSeconds: 90 }],
    })

    expect(videoSegments(out.project)).toEqual([
      { at: 0, from: 10 * SECOND, to: 25 * SECOND },
    ])
  })

  it('refuses to remove everything, which is a delete', () => {
    expect(() =>
      dispatch(talk(), 'remove_spoken_ranges', {
        segmentId: 'clip-1',
        ranges: [{ fromSeconds: 0, toSeconds: 60 }],
      }),
    ).toThrow(/Delete it instead/)
  })

  it('says so when no range touches what the clip plays', () => {
    expect(() =>
      dispatch(talk(), 'remove_spoken_ranges', {
        segmentId: 'clip-1',
        ranges: [{ fromSeconds: 90, toSeconds: 95 }],
      }),
    ).toThrow(/inside the part of the file/)
  })

  it('rejects a range that ends before it starts', () => {
    expect(() =>
      dispatch(talk(), 'remove_spoken_ranges', {
        segmentId: 'clip-1',
        ranges: [{ fromSeconds: 20, toSeconds: 10 }],
      }),
    ).toThrow(/must end after it starts/)
  })

  it('rejects ranges that are not ranges', () => {
    expect(() =>
      dispatch(talk(), 'remove_spoken_ranges', {
        segmentId: 'clip-1',
        ranges: [{ fromSeconds: 'ten', toSeconds: 20 }],
      }),
    ).toThrow(/fromSeconds must be a finite number/)

    expect(() =>
      dispatch(talk(), 'remove_spoken_ranges', {
        segmentId: 'clip-1',
        ranges: [],
      }),
    ).toThrow(/non-empty list/)
  })

  it('mints the ids for the pieces it creates', () => {
    // A model cannot see the ids already in use, so it is given none to invent.
    const spec = TOOL_SPECS.find((one) => one.name === 'remove_spoken_ranges')!
    expect(Object.keys(spec.fields)).toEqual(['segmentId', 'ranges'])
  })

  it('tells the person how much leaves, and the model what now exists', () => {
    const { step } = dispatch(talk(), 'remove_spoken_ranges', {
      segmentId: 'clip-1',
      ranges: [
        { fromSeconds: 10, toSeconds: 20 },
        { fromSeconds: 40, toSeconds: 50 },
      ],
    })

    // The label is read by somebody approving a cut: no ids, and the number
    // that matters is how much goes.
    expect(step.label).toContain('20.000s removed')
    expect(step.label).toContain('interview.mp4')
    expect(step.label).not.toContain('clip-1')

    // The summary is read by the model, which needs the pieces it now has.
    expect(step.summary).toContain('clip-1')
  })

  it('offers a schema the model can fill in', () => {
    const definition = TOOL_DEFINITIONS.find(
      (one) => one.name === 'remove_spoken_ranges',
    )!
    const ranges = definition.input_schema.properties['ranges'] as {
      type: string
      items: { required: string[] }
    }

    expect(ranges.type).toBe('array')
    expect(ranges.items.required).toEqual(['fromSeconds', 'toSeconds'])
  })
})
