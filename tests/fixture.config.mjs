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
