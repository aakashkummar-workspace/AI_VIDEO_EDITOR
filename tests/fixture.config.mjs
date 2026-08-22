/** Shape of the generated test clip. Frame 150 is the golden frame. */
export const FIXTURE = {
  path: 'tests/fixtures/counter-30fps.mp4',
  frames: 180,
  width: 320,
  height: 240,
  fps: 30,
  goldenFrame: 150,
}

/**
 * Timestamp to seek to in order to land on `goldenFrame`. Aiming at the middle
 * of the frame's interval keeps the seek robust against rounding in the muxed
 * timestamps.
 */
export function goldenFrameMicros() {
  const frameMicros = 1_000_000 / FIXTURE.fps
  return Math.round((FIXTURE.goldenFrame + 0.5) * frameMicros)
}

const SECOND = 1_000_000

/** The full source as a single clip, for absolute reference renders. */
export function wholeSourceSpec() {
  const durationMicros = (FIXTURE.frames / FIXTURE.fps) * SECOND
  return {
    composition: { width: FIXTURE.width, height: FIXTURE.height },
    sourceUrl: `/${FIXTURE.path}`,
    sourceDurationMicros: durationMicros,
    clips: [
      { sourceInMicros: 0, sourceOutMicros: durationMicros, timelineStartMicros: 0 },
    ],
  }
}

/**
 * Two clips with a gap between them:
 *
 *   timeline  0s ─── 2s        3s ─── 5s
 *   clip      [ A: src 0-2s ]  [ B: src 4-6s ]
 *                      └ gap ┘
 *
 * Clip B is the important one. Its timeline position (3-5s) and its source
 * range (4-6s) are offset by one second, so any implementation that ignores
 * sourceInMicros renders the wrong frame.
 */
export function gappedTimelineSpec() {
  return {
    composition: { width: FIXTURE.width, height: FIXTURE.height },
    sourceUrl: `/${FIXTURE.path}`,
    sourceDurationMicros: (FIXTURE.frames / FIXTURE.fps) * SECOND,
    clips: [
      { sourceInMicros: 0, sourceOutMicros: 2 * SECOND, timelineStartMicros: 0 },
      {
        sourceInMicros: 4 * SECOND,
        sourceOutMicros: 6 * SECOND,
        timelineStartMicros: 3 * SECOND,
      },
    ],
  }
}

/** Total length of gappedTimelineSpec, gap included. */
export const GAPPED_TIMELINE_DURATION = 5 * SECOND
