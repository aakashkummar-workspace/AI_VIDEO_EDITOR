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
import { segmentZoneAt, type DragMode } from '../timeline/dragging'
import { timelineDuration } from '../timeline/operations'
import {
  segmentDuration,
  textContent,
  transitionWindow,
  type Project,
  type Segment,
  type Track,
} from '../timeline/types'

export type TimelineProps = {
  project: Project
  /** Playhead position, in timeline microseconds. */
  currentMicros: number
  onSeek: (timelineMicros: number) => void
  onSegmentGrab: (
    segmentId: string,
    mode: DragMode,
    clientX: number,
    trackId: string,
  ) => void
  /** Which segment is selected, if any. */
  selectedId?: string | null
  onSelect?: (segmentId: string | null) => void
  /** The playhead head was grabbed, to scrub. */
  onPlayheadGrab?: (clientX: number) => void
  pixelsPerSecond?: number
  /** Reports a zoom the timeline initiated, e.g. ctrl+wheel. */
  onZoom?: (pixelsPerSecond: number) => void | undefined
}

const CURSOR_FOR: Record<DragMode, string> = {
  'trim-start': 'ew-resize',
  'trim-end': 'ew-resize',
  move: 'move',
}

/** What a block says on it: the file it plays, or the words it draws. */
function segmentLabel(project: Project, segment: Segment): string {
  const text = textContent(segment)
  if (text) return text.content

  const content = segment.content
  if (content.kind === 'text') return segment.id
  return project.sources[content.sourceId]?.name ?? content.sourceId
}

/**
 * The test id a block carries.
 *
 * Each kind keeps the name it had when it was its own type: what a user sees
 * on the row has not changed, only how the model stores it.
 */
const TESTID_FOR: Record<string, string> = {
  video: 'clip',
  text: 'overlay-block',
  audio: 'audio-block',
}

/**
 * The timeline: a ruler, one row per track, and a playhead.
 *
 * Rows are drawn top of the stack first, so a track that draws over another in
 * the composition also sits above it here.
 */
export default function Timeline({
  project,
  currentMicros,
  onSeek,
  onSegmentGrab,
  pixelsPerSecond = DEFAULT_PIXELS_PER_SECOND,
  onZoom = () => {},
  selectedId = null,
  onSelect = () => {},
  onPlayheadGrab = () => {},
}: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  const duration = timelineDuration(project)
  const width = trackWidth(duration, pixelsPerSecond)
  const ticks = rulerTicks(duration, pixelsPerSecond)
  const rows: Track[] = [...project.tracks].reverse()

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
        cursorOffsetPixels: event.clientX - strip.getBoundingClientRect().left,
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
    return segmentZoneAt(event.clientX - bounds.left, bounds.width)
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

        {rows.map((track) => (
          <div
            key={track.id}
            className={`timeline-track timeline-track-${track.kind}`}
            data-testid="track"
            data-track-id={track.id}
            data-track-kind={track.kind}
          >
            {track.segments.map((segment) => {
              const selected = segment.id === selectedId
              const classes = ['timeline-clip']
              if (track.kind === 'text') classes.push('timeline-overlay')
              if (track.kind === 'audio') classes.push('timeline-audio')
              if (selected) classes.push('is-selected')

              return (
                <div
                  key={segment.id}
                  className={classes.join(' ')}
                  data-testid={TESTID_FOR[track.kind] ?? 'clip'}
                  data-segment-id={segment.id}
                  data-track-id={track.id}
                  data-clip-id={track.kind === 'video' ? segment.id : undefined}
                  data-overlay-id={
                    track.kind === 'text' ? segment.id : undefined
                  }
                  style={{
                    left: microsToPixels(
                      segment.timelineStartMicros,
                      pixelsPerSecond,
                    ),
                    width: microsToPixels(
                      segmentDuration(segment),
                      pixelsPerSecond,
                    ),
                  }}
                  // Set directly rather than through state: the cursor has to
                  // track the pointer, and re-rendering the timeline on every
                  // mousemove to change one style is not worth it.
                  onMouseMove={(event) => {
                    event.currentTarget.style.cursor = CURSOR_FOR[zoneFor(event)]
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    onSelect(segment.id)
                    onSegmentGrab(
                      segment.id,
                      zoneFor(event),
                      event.clientX,
                      track.id,
                    )
                  }}
                >
                  {/* The stretch where this segment and the one before it
                      are both on screen. */}
                  {transitionWindow(segment) && (
                    <span
                      className="timeline-transition"
                      data-testid="transition-marker"
                      data-segment-id={segment.id}
                      style={{
                        width: microsToPixels(
                          segment.transitionIn!.durationMicros,
                          pixelsPerSecond,
                        ),
                      }}
                    />
                  )}
                  <span className="timeline-clip-label">
                    {segmentLabel(project, segment)}
                  </span>
                </div>
              )
            })}
          </div>
        ))}

        <div
          className="timeline-playhead"
          data-testid="playhead"
          style={{ left: microsToPixels(currentMicros, pixelsPerSecond) }}
        >
          {/* The line ignores the pointer; only the head is grabbable. */}
          <div
            className="timeline-playhead-head"
            data-testid="playhead-head"
            onMouseDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onPlayheadGrab(event.clientX)
            }}
          />
        </div>
      </div>
    </div>
  )
}
