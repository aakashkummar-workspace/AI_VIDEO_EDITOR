import type { MouseEvent } from 'react'
import {
  PIXELS_PER_SECOND,
  clampToTimeline,
  microsToPixels,
  pixelsToMicros,
  rulerTicks,
  trackWidth,
} from '../timeline/layout'
import { timelineDuration } from '../timeline/operations'
import { clipDuration, type Project } from '../timeline/types'

export type TimelineProps = {
  project: Project
  /** Playhead position, in timeline microseconds. */
  currentMicros: number
  onSeek: (timelineMicros: number) => void
  pixelsPerSecond?: number
}

/** Read-only view of the video track: a ruler, clip blocks, and a playhead. */
export default function Timeline({
  project,
  currentMicros,
  onSeek,
  pixelsPerSecond = PIXELS_PER_SECOND,
}: TimelineProps) {
  const duration = timelineDuration(project)
  const width = trackWidth(duration, pixelsPerSecond)
  const ticks = rulerTicks(duration, pixelsPerSecond)

  function handleClick(event: MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const micros = pixelsToMicros(event.clientX - bounds.left, pixelsPerSecond)
    onSeek(clampToTimeline(micros, duration))
  }

  return (
    <div className="timeline">
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
            >
              <span className="timeline-clip-label">
                {project.sources[clip.sourceId]?.name ?? clip.sourceId}
              </span>
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
