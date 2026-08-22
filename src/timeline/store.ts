import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer'
import { create } from 'zustand'
import {
  mutators,
  type AddClipInput,
  type MoveClipInput,
  type MoveOverlayInput,
  type OverlayStyleInput,
  type OverlayTrimInput,
  type SplitClipInput,
  type TrimInput,
} from './operations'
import {
  emptyProject,
  type Composition,
  type Overlay,
  type Project,
  type Source,
} from './types'

enablePatches()

/** One undo step: the patches that did it, and the patches that undo it. */
type Change = {
  patches: Patch[]
  inverse: Patch[]
}

/** How many undo steps to keep. */
const HISTORY_LIMIT = 100

export type TimelineStore = {
  project: Project
  past: Change[]
  future: Change[]

  setComposition: (composition: Composition) => void
  addSource: (source: Source) => void
  addClip: (input: AddClipInput) => void
  removeClip: (clipId: string) => void
  moveClip: (input: MoveClipInput) => void
  trimClipStart: (input: TrimInput) => void
  trimClipEnd: (input: TrimInput) => void
  splitClipAt: (input: SplitClipInput) => void

  addOverlay: (overlay: Overlay) => void
  removeOverlay: (overlayId: string) => void
  moveOverlay: (input: MoveOverlayInput) => void
  trimOverlayStart: (input: OverlayTrimInput) => void
  trimOverlayEnd: (input: OverlayTrimInput) => void
  setOverlayStyle: (input: OverlayStyleInput) => void

  undo: () => void
  redo: () => void
  canUndo: () => boolean
  canRedo: () => boolean
  reset: () => void
}

export const useTimelineStore = create<TimelineStore>((set, get) => {
  /**
   * Runs one mutator as a single undo step. If the mutator throws, produce
   * discards the draft and the store is left exactly as it was.
   */
  function apply<A>(mutator: (draft: Project, args: A) => void, args: A): void {
    const [project, patches, inverse] = produceWithPatches(
      get().project,
      (draft) => {
        mutator(draft, args)
      },
    )

    // A no-op operation should not cost an undo step.
    if (patches.length === 0) return

    const past = [...get().past, { patches, inverse }].slice(-HISTORY_LIMIT)
    set({ project, past, future: [] })
  }

  return {
    project: emptyProject(),
    past: [],
    future: [],

    /**
     * Registering a source is not an edit, so it is not undoable: undoing past
     * it would leave clips pointing at a source the project no longer knows.
     */
    addSource: (source) =>
      set((state) => ({
        project: produceWithPatches(state.project, (draft) => {
          mutators.addSource(draft, source)
        })[0],
      })),

    setComposition: (composition) =>
      apply(mutators.setComposition, composition),
    addClip: (input) => apply(mutators.addClip, input),
    removeClip: (clipId) => apply(mutators.removeClip, clipId),
    moveClip: (input) => apply(mutators.moveClip, input),
    trimClipStart: (input) => apply(mutators.trimClipStart, input),
    trimClipEnd: (input) => apply(mutators.trimClipEnd, input),
    splitClipAt: (input) => apply(mutators.splitClipAt, input),

    addOverlay: (overlay) => apply(mutators.addOverlay, overlay),
    removeOverlay: (overlayId) => apply(mutators.removeOverlay, overlayId),
    moveOverlay: (input) => apply(mutators.moveOverlay, input),
    trimOverlayStart: (input) => apply(mutators.trimOverlayStart, input),
    trimOverlayEnd: (input) => apply(mutators.trimOverlayEnd, input),
    setOverlayStyle: (input) => apply(mutators.setOverlayStyle, input),

    undo: () => {
      const { project, past, future } = get()
      const change = past.at(-1)
      if (!change) return

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

      set({
        project: applyPatches(project, change.patches),
        past: [...past, change],
        future: future.slice(0, -1),
      })
    },

    canUndo: () => get().past.length > 0,
    canRedo: () => get().future.length > 0,
    reset: () => set({ project: emptyProject(), past: [], future: [] }),
  }
})

// Test seam. The browser tests assert on real project state rather than on
// pixels or DOM attributes, so they need a handle on the store. Dev only:
// this is stripped from a production build.
if (import.meta.env.DEV) {
  ;(globalThis as unknown as Record<string, unknown>).__timelineStore =
    useTimelineStore
}
