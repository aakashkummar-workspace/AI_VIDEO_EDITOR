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
  moveOverlay,
  trimClipEnd,
  trimClipStart,
  trimOverlayEnd,
  trimOverlayStart,
  type MoveClipInput,
  type MoveOverlayInput,
  type OverlayTrimInput,
  type TrimInput,
} from './operations'
import {
  clipDuration,
  clipEndMicros,
  overlayEndMicros,
  type Clip,
  type Overlay,
  type Project,
} from './types'

/** How close to an edge counts as grabbing the edge rather than the clip. */
export const EDGE_GRAB_PIXELS = 6

export type DragMode = 'move' | 'trim-start' | 'trim-end'

/** Which row the gesture is on. Clips and overlays edit by different rules. */
export type DragTarget = 'clip' | 'overlay'

export type ClipDrag = {
  /** The id of the clip or overlay being dragged. */
  clipId: string
  mode: DragMode
  /** How far the mouse has moved since the gesture started. */
  deltaMicros: number
  /** Defaults to the video track. */
  target?: DragTarget
}

export type DragOperation =
  | { kind: 'move'; input: MoveClipInput }
  | { kind: 'trim-start'; input: TrimInput }
  | { kind: 'trim-end'; input: TrimInput }
  | { kind: 'move-overlay'; input: MoveOverlayInput }
  | { kind: 'trim-overlay-start'; input: OverlayTrimInput }
  | { kind: 'trim-overlay-end'; input: OverlayTrimInput }

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

export function findOverlay(
  project: Project,
  overlayId: string,
): Overlay | undefined {
  return project.overlays.find((overlay) => overlay.id === overlayId)
}

/**
 * An overlay gesture. Overlays may sit on top of one another, so unlike a clip
 * there is no neighbour to stop at - only the start of the timeline and a
 * positive duration, both of which the operations already clamp.
 */
function overlayDragToOperation(
  project: Project,
  drag: ClipDrag,
): DragOperation | null {
  const overlay = findOverlay(project, drag.clipId)
  if (!overlay) return null

  if (drag.mode === 'move') {
    const timelineStartMicros = Math.max(
      0,
      Math.round(overlay.timelineStartMicros + drag.deltaMicros),
    )
    if (timelineStartMicros === overlay.timelineStartMicros) return null

    return {
      kind: 'move-overlay',
      input: { overlayId: drag.clipId, timelineStartMicros },
    }
  }

  if (drag.mode === 'trim-start') {
    return {
      kind: 'trim-overlay-start',
      input: {
        overlayId: drag.clipId,
        timelineMicros: Math.round(
          overlay.timelineStartMicros + drag.deltaMicros,
        ),
      },
    }
  }

  return {
    kind: 'trim-overlay-end',
    input: {
      overlayId: drag.clipId,
      timelineMicros: Math.round(overlayEndMicros(overlay) + drag.deltaMicros),
    },
  }
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
  if (drag.target === 'overlay') return overlayDragToOperation(project, drag)

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
      case 'move-overlay':
        return moveOverlay(project, operation.input)
      case 'trim-overlay-start':
        return trimOverlayStart(project, operation.input)
      case 'trim-overlay-end':
        return trimOverlayEnd(project, operation.input)
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
  const item =
    drag.target === 'overlay'
      ? findOverlay(previewProject, drag.clipId)
      : findClip(previewProject, drag.clipId)
  if (!item) return null

  const start = item.timelineStartMicros
  const end =
    drag.target === 'overlay'
      ? overlayEndMicros(item as Overlay)
      : clipEndMicros(item as Clip)

  // The tail is exclusive, so step inside it to show the last frame.
  return drag.mode === 'trim-end' ? Math.max(start, end - 1) : start
}
