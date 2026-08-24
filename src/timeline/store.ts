import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer'
import { create } from 'zustand'
import {
  mutators,
  type AddEffectInput,
  type AddSegmentInput,
  type AddTrackInput,
  type EffectAmountInput,
  type EffectKeyframeInput,
  type KeyframeInput,
  type MoveSegmentInput,
  type SegmentPropertiesInput,
  type ChromaKeyInput,
  type MaskInput,
  type DuplicateSegmentInput,
  type KeepSourceSpansInput,
  type SplitSegmentInput,
  type TextStyleInput,
  type TransitionInput,
  type TrimInput,
} from './operations'
import {
  emptyProject,
  type AnimatableProperty,
  type BlendMode,
  type Composition,
  type ExportSettings,
  type Project,
  type Source,
} from './types'

enablePatches()

/** One undo step: the patches that did it, and the patches that undo it. */
type Change = {
  patches: Patch[]
  inverse: Patch[]
  /**
   * Set when this step may absorb the next one. Typing a caption is one edit,
   * not one edit per letter, so consecutive changes carrying the same key are
   * merged rather than stacked.
   */
  coalesceKey?: string
}

/** How many undo steps to keep. */
const HISTORY_LIMIT = 100

/**
 * One edit in a run worked out somewhere else - by the assistant, today.
 *
 * It names a mutator rather than carrying its own behaviour, so a run can only
 * ever do things the buttons and the keyboard can already do. A step that could
 * carry arbitrary work would be a second way to edit a project, which is
 * exactly what this codebase does not have.
 */
export type PlanStepInput = {
  mutator: keyof typeof mutators
  input: unknown
}

export type TimelineStore = {
  project: Project
  past: Change[]
  future: Change[]

  setComposition: (composition: Composition) => void
  setExportSettings: (settings: Partial<ExportSettings>) => void
  addSource: (source: Source) => void

  /**
   * Forgets a source and every segment that played it, as one undo step.
   *
   * Undoable, where adding a source is not - and the asymmetry is the point.
   * Undoing an ADDITION would strip a source out from under segments still
   * using it; undoing a REMOVAL puts the source and its segments back
   * together, which is a state the project was actually in.
   */
  removeSource: (sourceId: string) => void

  addTrack: (input: AddTrackInput) => void
  removeTrack: (trackId: string) => void
  moveTrack: (input: { trackId: string; index: number }) => void

  addSegment: (input: AddSegmentInput) => void
  removeSegment: (segmentId: string) => void
  moveSegment: (input: MoveSegmentInput) => void
  trimSegmentStart: (input: TrimInput) => void
  trimSegmentEnd: (input: TrimInput) => void
  duplicateSegment: (input: DuplicateSegmentInput) => void

  /**
   * Replaces a segment with the parts of it worth keeping, as one undo step.
   *
   * WHICH parts is decided elsewhere: it needs the waveform, and the waveform
   * is measured from the media rather than stored in the project. See
   * `silence.ts`.
   */
  keepSourceSpans: (input: KeepSourceSpansInput) => void

  /**
   * Runs a whole plan as ONE undo step.
   *
   * A run of edits somebody approved is one decision, so it has to be one
   * keystroke to take back - undoing an assistant's work a step at a time would
   * make rejecting it worse than never asking. Every step goes through the same
   * mutator its button would, so this is a second ROUTE to those edits and
   * never a second implementation of them.
   */
  applyPlan: (steps: PlanStepInput[]) => void
  splitSegmentAt: (input: SplitSegmentInput) => void
  setSegmentRate: (input: { segmentId: string; rate: number }) => void
  setSegmentBlendMode: (input: {
    segmentId: string
    blendMode: BlendMode
  }) => void
  setSegmentMask: (input: MaskInput) => void
  removeSegmentMask: (segmentId: string) => void
  setChromaKey: (input: ChromaKeyInput) => void
  removeChromaKey: (segmentId: string) => void
  setTransition: (input: TransitionInput) => void
  removeTransition: (segmentId: string) => void
  setTextStyle: (input: TextStyleInput) => void

  setSegmentProperties: (input: SegmentPropertiesInput) => void
  addKeyframe: (input: KeyframeInput) => void
  removeKeyframe: (input: {
    segmentId: string
    property: AnimatableProperty
    offsetMicros: number
  }) => void
  clearKeyframes: (input: {
    segmentId: string
    property?: AnimatableProperty
  }) => void

  addEffect: (input: AddEffectInput) => void
  removeEffect: (input: { segmentId: string; effectId: string }) => void
  setEffectAmount: (input: EffectAmountInput) => void
  moveEffect: (input: {
    segmentId: string
    effectId: string
    index: number
  }) => void
  addEffectKeyframe: (input: EffectKeyframeInput) => void
  removeEffectKeyframe: (input: {
    segmentId: string
    effectId: string
    offsetMicros: number
  }) => void

  /**
   * Ends the run of edits currently being merged, so the next one starts a
   * fresh undo step. Called when a field is left.
   */
  endCoalescing: () => void

  /**
   * Replaces everything with a project read from a draft.
   *
   * The history goes with it: undoing across a file being opened would walk
   * back into a timeline the user has closed, which is not what undo means.
   */
  openProject: (project: Project) => void

  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  reset: () => void
}

export const useTimelineStore = create<TimelineStore>((set, get) => {
  /** Which run of edits is currently absorbing further changes, if any. */
  let coalescing: string | null = null

  /**
   * Runs one mutator as a single undo step. If the mutator throws, produce
   * discards the draft and the store is left exactly as it was.
   *
   * With a `coalesceKey`, a change that follows another carrying the same key
   * is merged into it instead of pushed on top - otherwise a continuous
   * interaction like typing fills the history with intermediate states and
   * undo removes one keystroke at a time.
   */
  function apply<A>(
    mutator: (draft: Project, args: A) => void,
    args: A,
    coalesceKey?: string,
  ): void {
    const [project, patches, inverse] = produceWithPatches(
      get().project,
      (draft) => {
        mutator(draft, args)
      },
    )

    // A no-op operation should not cost an undo step.
    if (patches.length === 0) return

    const history = get().past
    const previous = history.at(-1)

    if (coalesceKey && coalescing === coalesceKey && previous) {
      // Redo replays the whole run in order; undo unwinds it newest first.
      const merged: Change = {
        patches: [...previous.patches, ...patches],
        inverse: [...inverse, ...previous.inverse],
        coalesceKey,
      }
      set({
        project,
        past: [...history.slice(0, -1), merged],
        future: [],
      })
      return
    }

    coalescing = coalesceKey ?? null
    const past = [...history, { patches, inverse, coalesceKey }].slice(
      -HISTORY_LIMIT,
    )
    set({ project, past, future: [] })
  }

  return {
    project: emptyProject(),
    past: [],
    future: [],

    /**
     * Registering a source is not an edit, so it is not undoable: undoing past
     * it would leave segments pointing at a source the project no longer knows.
     */
    addSource: (source) =>
      set((state) => ({
        project: produceWithPatches(state.project, (draft) => {
          mutators.addSource(draft, source)
        })[0],
      })),

    removeSource: (sourceId) => apply(mutators.removeSource, sourceId),

    setComposition: (composition) =>
      apply(mutators.setComposition, composition),
    setExportSettings: (settings) =>
      apply(mutators.setExportSettings, settings),

    addTrack: (input) => apply(mutators.addTrack, input),
    removeTrack: (trackId) => apply(mutators.removeTrack, trackId),
    moveTrack: (input) => apply(mutators.moveTrack, input),

    addSegment: (input) => apply(mutators.addSegment, input),
    removeSegment: (segmentId) => apply(mutators.removeSegment, segmentId),
    moveSegment: (input) => apply(mutators.moveSegment, input),
    trimSegmentStart: (input) => apply(mutators.trimSegmentStart, input),
    trimSegmentEnd: (input) => apply(mutators.trimSegmentEnd, input),
    duplicateSegment: (input) => apply(mutators.duplicateSegment, input),
    keepSourceSpans: (input) => apply(mutators.keepSourceSpans, input),

    /**
     * If any step throws, produce discards the draft and the project is left
     * exactly as it was - a half-applied plan would be worse than none, since
     * there would be nothing to point undo at.
     */
    applyPlan: (steps) =>
      apply((draft, list: PlanStepInput[]) => {
        for (const step of list) {
          const mutate = mutators[step.mutator] as (
            draft: Project,
            input: unknown,
          ) => void
          mutate(draft, step.input)
        }
      }, steps),
    splitSegmentAt: (input) => apply(mutators.splitSegmentAt, input),
    setSegmentBlendMode: (input) =>
      apply(mutators.setSegmentBlendMode, input),
    /** Dragging a mask handle is one edit, like every other drag. */
    setSegmentMask: (input) =>
      apply(
        mutators.setSegmentMask,
        input,
        `mask:${input.segmentId}:${Object.keys(input)
          .filter((field) => field !== 'segmentId')
          .sort()
          .join(',')}`,
      ),
    removeSegmentMask: (segmentId) =>
      apply(mutators.removeSegmentMask, segmentId),
    /** Dragging a tolerance slider is one edit, like every other slider. */
    setChromaKey: (input) =>
      apply(
        mutators.setChromaKey,
        input,
        `key:${input.segmentId}:${Object.keys(input)
          .filter((field) => field !== 'segmentId')
          .sort()
          .join(',')}`,
      ),
    removeChromaKey: (segmentId) =>
      apply(mutators.removeChromaKey, segmentId),
    /** Dragging a speed slider is one edit, like every other slider. */
    setSegmentRate: (input) =>
      apply(mutators.setSegmentRate, input, `rate:${input.segmentId}`),
    /** Dragging the length of a transition is one edit, like any other slider. */
    setTransition: (input) =>
      apply(
        mutators.setTransition,
        input,
        `transition:${input.segmentId}`,
      ),
    removeTransition: (segmentId) =>
      apply(mutators.removeTransition, segmentId),
    /**
     * The key names the segment and the exact fields being changed, so typing
     * merges with typing but a nudge of x afterwards starts its own step.
     */
    setTextStyle: (input) =>
      apply(
        mutators.setTextStyle,
        input,
        `style:${input.segmentId}:${Object.keys(input)
          .filter((field) => field !== 'segmentId')
          .sort()
          .join(',')}`,
      ),

    /**
     * Dragging a scale slider is one edit, like typing a caption is: the key
     * names the segment and the exact fields, so a slider merges with itself
     * but not with the next control along.
     */
    setSegmentProperties: (input) =>
      apply(
        mutators.setSegmentProperties,
        input,
        `properties:${input.segmentId}:${Object.keys(input)
          .filter((field) => field !== 'segmentId')
          .sort()
          .join(',')}`,
      ),

    addKeyframe: (input) => apply(mutators.addKeyframe, input),
    removeKeyframe: (input) => apply(mutators.removeKeyframe, input),
    clearKeyframes: (input) => apply(mutators.clearKeyframes, input),

    addEffect: (input) => apply(mutators.addEffect, input),
    removeEffect: (input) => apply(mutators.removeEffect, input),
    moveEffect: (input) => apply(mutators.moveEffect, input),
    /** Dragging one effect slider is one undo step, like every other slider. */
    setEffectAmount: (input) =>
      apply(
        mutators.setEffectAmount,
        input,
        `effect:${input.segmentId}:${input.effectId}`,
      ),
    addEffectKeyframe: (input) => apply(mutators.addEffectKeyframe, input),
    removeEffectKeyframe: (input) =>
      apply(mutators.removeEffectKeyframe, input),

    openProject: (project) => {
      coalescing = null
      set({ project, past: [], future: [] })
    },

    endCoalescing: () => {
      coalescing = null
    },

    undo: () => {
      const { project, past, future } = get()
      const change = past.at(-1)
      if (!change) return
      coalescing = null

      set({
        project: applyPatches(project, change.inverse),
        past: past.slice(0, -1),
        future: [...future, change],
      })
    },

    redo: () => {
      const { project, past, future } = get()
      const change = future.at(-1)
      if (!change) return
      coalescing = null

      set({
        project: applyPatches(project, change.patches),
        past: [...past, change],
        future: future.slice(0, -1),
      })
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,
    reset: () => {
      coalescing = null
      set({ project: emptyProject(), past: [], future: [] })
    },
  }
})

// Test seam. The browser tests assert on real project state rather than on
// pixels or DOM attributes, so they need a handle on the store. Dev only:
// this is stripped from a production build.
if (import.meta.env.DEV) {
  ;(globalThis as unknown as Record<string, unknown>).__timelineStore =
    useTimelineStore
}
