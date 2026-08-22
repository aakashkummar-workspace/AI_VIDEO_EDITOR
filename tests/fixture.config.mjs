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
 * A second clip that differs from the first on both axes that matter:
 * 16:9 rather than 4:3, and 24fps rather than 30. Used to prove that sources
 * of different shapes letterbox instead of stretching, and that the timeline
 * clock rather than any source's frame rate governs playback speed.
 */
export const FIXTURE_B = {
  path: 'tests/fixtures/counter-24fps-wide.mp4',
  frames: 120,
  width: 480,
  height: 270,
  fps: 24,
  hueOffset: 180,
  marker: 'block',
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

const SOURCE_A = { id: 'src-a', url: `/${FIXTURE.path}` }
const SOURCE_B = { id: 'src-b', url: `/${FIXTURE_B.path}` }

/**
 * One source as a single clip, for absolute reference renders. The composition
 * is that source's own shape, so nothing is letterboxed and the reference is
 * the raw decoded frame.
 */
export function wholeSourceSpec(which = 'a') {
  const fixture = which === 'a' ? FIXTURE : FIXTURE_B
  const source = which === 'a' ? SOURCE_A : SOURCE_B
  const durationMicros = (fixture.frames / fixture.fps) * SECOND

  return {
    composition: { width: fixture.width, height: fixture.height },
    sources: [source],
    clips: [
      {
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: durationMicros,
        timelineStartMicros: 0,
      },
    ],
  }
}

/**
 * Two clips from two DIFFERENT sources, with a gap between them:
 *
 *   timeline  0s ─── 2s        3s ─── 5s
 *   clip      [ A: src-a 0-2s ][ B: src-b 2-4s ]
 *                      └ gap ┘
 *
 * Source A is 320x240 at 30fps; source B is 480x270 at 24fps. The composition
 * is A's shape, so B has to letterbox rather than stretch. Clip B is also
 * offset - timeline 3-5s against source 2-4s - so an implementation that
 * ignores sourceInMicros renders the wrong frame.
 */
export function gappedTimelineSpec() {
  return {
    composition: { width: FIXTURE.width, height: FIXTURE.height },
    sources: [SOURCE_A, SOURCE_B],
    clips: [
      {
        sourceId: SOURCE_A.id,
        sourceInMicros: 0,
        sourceOutMicros: 2 * SECOND,
        timelineStartMicros: 0,
      },
      {
        sourceId: SOURCE_B.id,
        sourceInMicros: 2 * SECOND,
        sourceOutMicros: 4 * SECOND,
        timelineStartMicros: 3 * SECOND,
      },
    ],
  }
}

/** Total length of gappedTimelineSpec, gap included. */
export const GAPPED_TIMELINE_DURATION = 5 * SECOND
