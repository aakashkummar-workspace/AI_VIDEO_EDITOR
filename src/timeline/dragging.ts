/**
 * Turns mouse gestures into calls to the timeline operations.
 *
 * This layer owns no editing rules of its own: it decides which operation a
 * gesture means and with what argument, then defers to operations.ts. The
 * preview shown during a drag is the very same operation applied purely, so
 * what you see mid-drag and what gets committed cannot disagree.
 *
 * A gesture no longer says what kind of thing it is dragging. The segment
 * knows which track it sits on, and the track decides whether the drag has a
 * neighbour to stop at, so one set of gestures covers every row.
 */

import {
  moveSegment,
  trimSegmentEnd,
  trimSegmentStart,
  type MoveSegmentInput,
  type TrimInput,
} from './operations'
import {
  findSegment,
  segmentDuration,
  segmentEndMicros,
  trackAllowsOverlap,
  type Project,
  type Segment,
  type Track,
} from './types'

/** How close to an edge counts as grabbing the edge rather than the segment. */
export const EDGE_GRAB_PIXELS = 6

export type DragMode = 'move' | 'trim-start' | 'trim-end'

export type SegmentDrag = {
  segmentId: string
  mode: DragMode
  /** How far the mouse has moved since the gesture started. */
  deltaMicros: number
  /** The row the pointer is currently over, when it is not the original one. */
  trackId?: string
}

export type DragOperation =
  | { kind: 'move'; input: MoveSegmentInput }
  | { kind: 'trim-start'; input: TrimInput }
  | { kind: 'trim-end'; input: TrimInput }

/** Which part of a segment block the pointer is over. */
export function segmentZoneAt(
  offsetPixels: number,
  segmentWidthPixels: number,
): DragMode {
  // A very narrow segment is all edges; prefer the tail so it can still grow.
  if (segmentWidthPixels <= EDGE_GRAB_PIXELS * 2) {
    return offsetPixels < segmentWidthPixels / 2 ? 'trim-start' : 'trim-end'
  }
  if (offsetPixels <= EDGE_GRAB_PIXELS) return 'trim-start'
  if (offsetPixels >= segmentWidthPixels - EDGE_GRAB_PIXELS) return 'trim-end'
  return 'move'
}

export function findDragSegment(
  project: Project,
  segmentId: string,
): { track: Track; segment: Segment } | undefined {
  return findSegment(project, segmentId)
}

/**
 * How far a segment may slide before it hits something.
 *
 * On a row that packs its segments this is bounded by the immediate
 * neighbours, so dragging into one stops at its edge rather than jumping over
 * it or throwing. A row that allows overlap has no neighbours to speak of.
 */
export function legalStartRange(
  project: Project,
  segmentId: string,
): { minMicros: number; maxMicros: number } {
  const found = findSegment(project, segmentId)
  if (!found) return { minMicros: 0, maxMicros: 0 }

  const { track, segment, index } = found
  if (trackAllowsOverlap(track.kind)) {
    return { minMicros: 0, maxMicros: Number.MAX_SAFE_INTEGER }
  }

  const previous = track.segments[index - 1]
  const next = track.segments[index + 1]

  return {
    minMicros: previous ? segmentEndMicros(previous) : 0,
    maxMicros: next
      ? next.timelineStartMicros - segmentDuration(segment)
      : Number.MAX_SAFE_INTEGER,
  }
}

/** Clamps a proposed start into the legal range, so a move never overlaps. */
export function clampSegmentStart(
  project: Project,
  segmentId: string,
  desiredStartMicros: number,
): number {
  const { minMicros, maxMicros } = legalStartRange(project, segmentId)
  const clamped = Math.min(Math.max(desiredStartMicros, minMicros), maxMicros)
  return Math.max(0, Math.round(clamped))
}

/**
 * The operation a gesture means, or null if it would change nothing.
 *
 * Trims pass the raw target through: the trim operations already clamp to the
 * source bounds, the neighbouring segment, and a positive duration.
 */
export function dragToOperation(
  project: Project,
  drag: SegmentDrag,
): DragOperation | null {
  const found = findSegment(project, drag.segmentId)
  if (!found) return null

  const { track, segment } = found

  if (drag.mode === 'move') {
    // Crossing to another row is a move even when the time does not change.
    const crossing = drag.trackId !== undefined && drag.trackId !== track.id
    const timelineStartMicros = clampSegmentStart(
      project,
      drag.segmentId,
      segment.timelineStartMicros + drag.deltaMicros,
    )
    if (!crossing && timelineStartMicros === segment.timelineStartMicros) {
      return null
    }

    return {
      kind: 'move',
      input: {
        segmentId: drag.segmentId,
        timelineStartMicros,
        ...(crossing ? { trackId: drag.trackId } : {}),
      },
    }
  }

  if (drag.mode === 'trim-start') {
    return {
      kind: 'trim-start',
      input: {
        segmentId: drag.segmentId,
        timelineMicros: Math.round(
          segment.timelineStartMicros + drag.deltaMicros,
        ),
      },
    }
  }

  return {
    kind: 'trim-end',
    input: {
      segmentId: drag.segmentId,
      timelineMicros: Math.round(segmentEndMicros(segment) + drag.deltaMicros),
    },
  }
}

/**
 * The project as it would look if the gesture were committed right now. Total:
 * a gesture that cannot be applied returns the project untouched, which is what
 * makes an illegal drag snap back instead of throwing.
 */
export function applyDrag(project: Project, drag: SegmentDrag): Project {
  const operation = dragToOperation(project, drag)
  if (!operation) return project

  try {
    switch (operation.kind) {
      case 'move':
        return moveSegment(project, operation.input)
      case 'trim-start':
        return trimSegmentStart(project, operation.input)
      case 'trim-end':
        return trimSegmentEnd(project, operation.input)
    }
  } catch {
    return project
  }
}

/** Where the preview should be parked while a gesture is in progress. */
export function dragPreviewMicros(
  previewProject: Project,
  drag: SegmentDrag,
): number | null {
  const found = findSegment(previewProject, drag.segmentId)
  if (!found) return null

  const { segment } = found
  const start = segment.timelineStartMicros
  const end = segmentEndMicros(segment)

  // The tail is exclusive, so step inside it to show the last frame.
  return drag.mode === 'trim-end' ? Math.max(start, end - 1) : start
}
