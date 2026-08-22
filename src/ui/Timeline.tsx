import { useEffect, useRef, type MouseEvent } from 'react'
import {
  DEFAULT_PIXELS_PER_SECOND,
  clampToTimeline,
  microsToPixels,
  pixelsToMicros,
  rulerTicks,
  trackWidth,
  zoomAround,
  ZOOM_STEP,
} from '../timeline/layout'
import {
  clipZoneAt,
  type DragMode,
  type DragTarget,
} from '../timeline/dragging'
import { timelineDuration } from '../timeline/operations'
import { clipDuration, type Project } from '../timeline/types'

export type TimelineProps = {
  project: Project
  /** Playhead position, in timeline microseconds. */
  currentMicros: number
  onSeek: (timelineMicros: number) => void
  onClipGrab: (
    itemId: string,
    mode: DragMode,
    clientX: number,
    target: DragTarget,
  ) => void
  /** Which clip or overlay is selected, if any. */
  selectedId?: string | null
  onSelect?: (id: string | null, target: DragTarget) => void
  pixelsPerSecond?: number
  /** Reports a zoom the timeline initiated, e.g. ctrl+wheel. */
  onZoom?: (pixelsPerSecond: number) => void | undefined
}

const CURSOR_FOR: Record<DragMode, string> = {
  'trim-start': 'ew-resize',
  'trim-end': 'ew-resize',
  move: 'move',
}

/** The video track: a ruler, clip blocks, and a playhead. */
export default function Timeline({
  project,
  currentMicros,
  onSeek,
  onClipGrab,
  pixelsPerSecond = DEFAULT_PIXELS_PER_SECOND,
  onZoom = () => {},
  selectedId = null,
  onSelect = () => {},
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const duration = timelineDuration(project)
  const width = trackWidth(duration, pixelsPerSecond)
  const ticks = rulerTicks(duration, pixelsPerSecond)

  // Wheel zoom is bound by hand rather than via onWheel, because React attaches
  // wheel listeners passively and a passive listener cannot preventDefault -
  // the browser would zoom the whole page instead.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return

    function onWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()

      const strip = scrollRef.current
      if (!strip) return

      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      const next = zoomAround({
        pixelsPerSecond,
        scrollLeft: strip.scrollLeft,
        cursorOffsetPixels:
          event.clientX - strip.getBoundingClientRect().left,
        factor,
      })

      strip.scrollLeft = next.scrollLeft
      onZoom(next.pixelsPerSecond)
    }

    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [pixelsPerSecond, onZoom])

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const micros = pixelsToMicros(event.clientX - bounds.left, pixelsPerSecond)
    onSeek(clampToTimeline(micros, duration))
  }

  function zoneFor(event: MouseEvent<HTMLDivElement>): DragMode {
    const bounds = event.currentTarget.getBoundingClientRect()
    return clipZoneAt(event.clientX - bounds.left, bounds.width)
  }

  return (
    <div className="timeline" ref={scrollRef} data-testid="timeline-scroll">
      <div
        className="timeline-inner"
        style={{ width }}
        onClick={handleClick}
        data-testid="timeline"
      >
        <div className="timeline-ruler">
          {ticks.map((tick) => (
            <div
              key={tick.micros}
              className="timeline-tick"
              style={{ left: tick.x }}
            >
              <span className="timeline-tick-label">{tick.label}</span>
            </div>
          ))}
        </div>

        <div className="timeline-track">
          {project.videoTrack.clips.map((clip) => (
            <div
              key={clip.id}
              className="timeline-clip"
              data-testid="clip"
              data-clip-id={clip.id}
              style={{
                left: microsToPixels(clip.timelineStartMicros, pixelsPerSecond),
                width: microsToPixels(clipDuration(clip), pixelsPerSecond),
              }}
              // Set directly rather than through state: the cursor has to
              // track the pointer, and re-rendering the timeline on every
              // mousemove to change one style is not worth it.
              onMouseMove={(event) => {
                event.currentTarget.style.cursor = CURSOR_FOR[zoneFor(event)]
              }}
              onMouseDown={(event) => {
                event.preventDefault()
                onSelect(clip.id, 'clip')
                onClipGrab(clip.id, zoneFor(event), event.clientX, 'clip')
              }}
            >
              <span className="timeline-clip-label">
                {project.sources[clip.sourceId]?.name ?? clip.sourceId}
              </span>
            </div>
          ))}
        </div>

        <div className="timeline-track timeline-overlays">
          {project.overlays.map((overlay) => (
            <div
              key={overlay.id}
              className={
                overlay.id === selectedId
                  ? 'timeline-clip timeline-overlay is-selected'
                  : 'timeline-clip timeline-overlay'
              }
              data-testid="overlay-block"
              data-overlay-id={overlay.id}
              style={{
                left: microsToPixels(
                  overlay.timelineStartMicros,
                  pixelsPerSecond,
                ),
                width: microsToPixels(overlay.durationMicros, pixelsPerSecond),
              }}
              onMouseMove={(event) => {
                event.currentTarget.style.cursor = CURSOR_FOR[zoneFor(event)]
              }}
              onMouseDown={(event) => {
                event.preventDefault()
                onSelect(overlay.id, 'overlay')
                onClipGrab(overlay.id, zoneFor(event), event.clientX, 'overlay')
              }}
            >
              <span className="timeline-clip-label">{overlay.content}</span>
            </div>
          ))}
        </div>

        <div
          className="timeline-playhead"
          data-testid="playhead"
          style={{ left: microsToPixels(currentMicros, pixelsPerSecond) }}
        />
      </div>
    </div>
  )
}
