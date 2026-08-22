/**
 * Turns mouse gestures into calls to the timeline operations.
 *
 * This layer owns no editing rules of its own: it decides which operation a
 * gesture means and with what argument, then defers to operations.ts. The
 * preview shown during a drag is the very same operation applied purely, so
 * what you see mid-drag and what gets committed cannot disagree.
 */

import {
  moveClip,
  trimClipEnd,
  trimClipStart,
  type MoveClipInput,
  type TrimInput,
} from './operations'
import { clipDuration, clipEndMicros, type Clip, type Project } from './types'

/** How close to an edge counts as grabbing the edge rather than the clip. */
export const EDGE_GRAB_PIXELS = 6

export type DragMode = 'move' | 'trim-start' | 'trim-end'

export type ClipDrag = {
  clipId: string
  mode: DragMode
  /** How far the mouse has moved since the gesture started. */
  deltaMicros: number
}

export type DragOperation =
  | { kind: 'move'; input: MoveClipInput }
  | { kind: 'trim-start'; input: TrimInput }
  | { kind: 'trim-end'; input: TrimInput }

/** Which part of a clip block the pointer is over. */
export function clipZoneAt(
  offsetPixels: number,
  clipWidthPixels: number,
): DragMode {
  // A very narrow clip is all edges; prefer the tail so it can still grow.
  if (clipWidthPixels <= EDGE_GRAB_PIXELS * 2) {
    return offsetPixels < clipWidthPixels / 2 ? 'trim-start' : 'trim-end'
  }
  if (offsetPixels <= EDGE_GRAB_PIXELS) return 'trim-start'
  if (offsetPixels >= clipWidthPixels - EDGE_GRAB_PIXELS) return 'trim-end'
  return 'move'
}

export function findClip(project: Project, clipId: string): Clip | undefined {
  return project.videoTrack.clips.find((clip) => clip.id === clipId)
}

/**
 * How far a clip may slide before it hits something.
 *
 * Bounded by its immediate neighbours, so dragging into one stops at its edge
 * rather than jumping over it or throwing.
 */
export function legalStartRange(
  project: Project,
  clipId: string,
): { minMicros: number; maxMicros: number } {
  const clips = project.videoTrack.clips
  const index = clips.findIndex((clip) => clip.id === clipId)
  if (index < 0) return { minMicros: 0, maxMicros: 0 }

  const clip = clips[index]!
  const previous = clips[index - 1]
  const next = clips[index + 1]

  return {
    minMicros: previous ? clipEndMicros(previous) : 0,
    maxMicros: next
      ? next.timelineStartMicros - clipDuration(clip)
      : Number.MAX_SAFE_INTEGER,
  }
}

/** Clamps a proposed start into the legal range, so a move never overlaps. */
export function clampClipStart(
  project: Project,
  clipId: string,
  desiredStartMicros: number,
): number {
  const { minMicros, maxMicros } = legalStartRange(project, clipId)
  const clamped = Math.min(Math.max(desiredStartMicros, minMicros), maxMicros)
  return Math.max(0, Math.round(clamped))
}

/**
 * The operation a gesture means, or null if it would change nothing.
 *
 * Trims pass the raw target through: the trim operations already clamp to the
 * source bounds, the neighbouring clip, and a positive duration.
 */
export function dragToOperation(
  project: Project,
  drag: ClipDrag,
): DragOperation | null {
  const clip = findClip(project, drag.clipId)
  if (!clip) return null

  if (drag.mode === 'move') {
    const timelineStartMicros = clampClipStart(
      project,
      drag.clipId,
      clip.timelineStartMicros + drag.deltaMicros,
    )
    if (timelineStartMicros === clip.timelineStartMicros) return null

    return { kind: 'move', input: { clipId: drag.clipId, timelineStartMicros } }
  }

  if (drag.mode === 'trim-start') {
    return {
      kind: 'trim-start',
      input: {
        clipId: drag.clipId,
        timelineMicros: Math.round(
          clip.timelineStartMicros + drag.deltaMicros,
        ),
      },
    }
  }

  return {
    kind: 'trim-end',
    input: {
      clipId: drag.clipId,
      timelineMicros: Math.round(clipEndMicros(clip) + drag.deltaMicros),
    },
  }
}

/**
 * The project as it would look if the gesture were committed right now. Total:
 * a gesture that cannot be applied returns the project untouched, which is what
 * makes an illegal drag snap back instead of throwing.
 */
export function applyDrag(project: Project, drag: ClipDrag): Project {
  const operation = dragToOperation(project, drag)
  if (!operation) return project

  try {
    switch (operation.kind) {
      case 'move':
        return moveClip(project, operation.input)
      case 'trim-start':
        return trimClipStart(project, operation.input)
      case 'trim-end':
        return trimClipEnd(project, operation.input)
    }
  } catch {
    return project
  }
}

/** Where the preview should be parked while a gesture is in progress. */
export function dragPreviewMicros(
  previewProject: Project,
  drag: ClipDrag,
): number | null {
  const clip = findClip(previewProject, drag.clipId)
  if (!clip) return null

  // The tail is exclusive, so step inside it to show the last frame.
  return drag.mode === 'trim-end'
    ? Math.max(clip.timelineStartMicros, clipEndMicros(clip) - 1)
    : clip.timelineStartMicros
}
