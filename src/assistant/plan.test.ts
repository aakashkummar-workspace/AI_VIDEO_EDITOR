import { beforeEach, describe, expect, it } from 'vitest'
import { dispatch, type PlanStep } from './tools'
import { addSegment, addSource } from '../timeline/operations'
import { useTimelineStore } from '../timeline/store'
import {
  MAIN_VIDEO_TRACK_ID,
  emptyProject,
  findSegment,
  segmentEndMicros,
  type Project,
  type Source,
} from '../timeline/types'

/**
 * What happens to a plan once somebody approves it.
 *
 * The planning loop itself needs a network and is covered in the browser suite
 * with a stubbed API. What matters here is the half that has no network in it:
 * that working a plan out changes nothing, and that approving one is a single
 * decision to take back.
 */

const SECOND = 1_000_000

const source: Source = {
  id: 'src-a',
  name: 'a.mp4',
  durationMicros: 10 * SECOND,
  width: 320,
  height: 240,
  rotation: 0,
}

/**
 * Loads the starting project through `openProject`, which clears the history.
 * Seeding with the store's own actions would leave undo steps of its own on the
 * stack, and every test here is about how many steps something costs.
 */
function seedProject(): void {
  const project = addSegment(addSource(emptyProject(), source), {
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

  useTimelineStore.getState().openProject(project)
}

/** Works a run out against a scratch copy, exactly as the assistant does. */
function planAgainst(
  project: Project,
  calls: { tool: string; args: Record<string, unknown> }[],
): { steps: PlanStep[]; project: Project } {
  let scratch = project
  const steps: PlanStep[] = []
  let minted = 0

  for (const call of calls) {
    const outcome = dispatch(scratch, call.tool, call.args, () => {
      minted += 1
      return `minted-${minted}`
    })
    scratch = outcome.project
    steps.push(outcome.step)
  }

  return { steps, project: scratch }
}

describe('planning', () => {
  beforeEach(() => {
    seedProject()
  })

  it('changes nothing in the store while it is being worked out', () => {
    const before = useTimelineStore.getState().project

    const { steps, project } = planAgainst(before, [
      { tool: 'split_segment', args: { atSeconds: 2 } },
      { tool: 'set_speed', args: { segmentId: 'clip-1', rate: 2 } },
    ])

    expect(steps).toHaveLength(2)
    // The scratch copy moved on; the store did not.
    expect(project).not.toBe(before)
    expect(useTimelineStore.getState().project).toBe(before)
    expect(useTimelineStore.getState().canUndo()).toBe(false)
  })
})

describe('applying a plan', () => {
  beforeEach(() => {
    seedProject()
  })

  it('is one undo step however many edits it contains', () => {
    // The point of the whole flow: a run somebody approved is one decision, so
    // rejecting it afterwards must not mean pressing undo five times.
    const { steps } = planAgainst(useTimelineStore.getState().project, [
      { tool: 'split_segment', args: { atSeconds: 2 } },
      { tool: 'add_text', args: { text: 'hi', startSeconds: 0, durationSeconds: 1 } },
      { tool: 'set_properties', args: { segmentId: 'clip-1', opacity: 0.5 } },
    ])

    const before = useTimelineStore.getState().project
    useTimelineStore.getState().applyPlan(steps)

    const after = useTimelineStore.getState().project
    expect(after).not.toBe(before)
    expect(findSegment(after, 'minted-1')).toBeDefined()
    expect(findSegment(after, 'minted-2')).toBeDefined()
    expect(findSegment(after, 'clip-1')!.segment.properties?.opacity).toBe(0.5)

    useTimelineStore.getState().undo()

    expect(useTimelineStore.getState().project).toEqual(before)
    expect(useTimelineStore.getState().canUndo()).toBe(false)
  })

  it('produces the same project the plan was worked out against', () => {
    // If these could differ, the list somebody approved would not be the edit
    // they got.
    const { steps, project: predicted } = planAgainst(
      useTimelineStore.getState().project,
      [
        { tool: 'split_segment', args: { atSeconds: 1.5 } },
        { tool: 'duplicate_segment', args: { segmentId: 'clip-1' } },
      ],
    )

    useTimelineStore.getState().applyPlan(steps)

    expect(useTimelineStore.getState().project).toEqual(predicted)
  })

  it('applies all of a plan or none of it', () => {
    const good = planAgainst(useTimelineStore.getState().project, [
      { tool: 'set_properties', args: { segmentId: 'clip-1', opacity: 0.25 } },
    ]).steps

    // A step that cannot run - the segment it names is not there. Half a plan
    // would leave nothing sensible to point undo at.
    const broken: PlanStep[] = [
      ...good,
      {
        tool: 'delete_segment',
        mutator: 'removeSegment',
        input: 'no-such-segment',
        summary: 'delete_segment: no-such-segment removed',
        label: 'Delete that segment',
      },
    ]

    const before = useTimelineStore.getState().project
    expect(() => useTimelineStore.getState().applyPlan(broken)).toThrow()

    expect(useTimelineStore.getState().project).toBe(before)
    expect(useTimelineStore.getState().canUndo()).toBe(false)
  })

  it('costs no undo step when the plan is empty', () => {
    useTimelineStore.getState().applyPlan([])

    expect(useTimelineStore.getState().canUndo()).toBe(false)
  })

  it('leaves the segments where the summaries said they would be', () => {
    // A transition pulls the incoming segment and everything after it earlier,
    // so this is the case where believing the request rather than the result
    // would have been wrong.
    const { steps } = planAgainst(useTimelineStore.getState().project, [
      { tool: 'duplicate_segment', args: { segmentId: 'clip-1' } },
      {
        tool: 'add_transition',
        args: { segmentId: 'minted-1', kind: 'crossfade', durationSeconds: 1 },
      },
    ])

    useTimelineStore.getState().applyPlan(steps)

    const copy = findSegment(useTimelineStore.getState().project, 'minted-1')!
    expect(copy.segment.timelineStartMicros).toBe(3 * SECOND)
    expect(segmentEndMicros(copy.segment)).toBe(7 * SECOND)
    expect(steps[1]!.summary).toContain('3.000s')
  })
})
