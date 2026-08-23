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
 * A third clip carrying audio: one pure tone per second, so a decoded window
 * can be traced back to the second it came from. 100Hz apart, well clear of
 * any confusion after lossy encoding.
 */
export const FIXTURE_TONES = {
  path: 'tests/fixtures/tones-30fps.mp4',
  frames: 180,
  width: 320,
  height: 240,
  fps: 30,
  hueOffset: 90,
  marker: 'bar',
  audioSampleRate: 48_000,
  toneHz: [300, 400, 500, 600, 700, 800],
}

/**
 * A fourth clip at a DIFFERENT audio sample rate, to prove mixed rates play
 * and export together.
 */
export const FIXTURE_TONES_44K = {
  path: 'tests/fixtures/tones-44k.mp4',
  frames: 90,
  width: 320,
  height: 240,
  fps: 30,
  hueOffset: 270,
  marker: 'block',
  audioSampleRate: 44_100,
  toneHz: [900, 1000, 1100],
}

/**
 * A green screen: a flat keying green with a red block moving across it.
 *
 * Flat and evenly lit on purpose. A real green screen is neither, and the
 * shader is built for that, but a test wants an answer it can state exactly:
 * everything green should go, the red block should stay.
 */
export const FIXTURE_GREEN = {
  path: 'tests/fixtures/green-screen.mp4',
  frames: 60,
  width: 320,
  height: 240,
  fps: 30,
  solidColor: '#00b140',
  markerColor: '#ff2020',
  marker: 'block',
}

/**
 * A fixture with NO PICTURE AT ALL: a piece of music, in other words.
 *
 * `frames: 0` is what makes it audio-only. Importing one of these is the whole
 * point of an audio row, and it exercises the paths that must not assume every
 * source has a video track.
 */
export const FIXTURE_MUSIC = {
  path: 'tests/fixtures/music-only.mp4',
  frames: 0,
  width: 0,
  height: 0,
  fps: 30,
  seconds: 4,
  audioSampleRate: 48_000,
  toneHz: [220, 330, 440, 550],
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

const TONES_A = { id: 'src-tones', url: `/${FIXTURE_TONES.path}` }
const TONES_B = { id: 'src-tones-44k', url: `/${FIXTURE_TONES_44K.path}` }

/**
 * Two tone clips at DIFFERENT sample rates with a gap between them:
 *
 *   timeline  0s ─── 2s        3s ─── 5s
 *   clip      [ A: src 1-3s ]  [ B: src 0-2s ]
 *                      └ gap ┘
 *
 * Clip A is offset in its source, so timeline second 0 must carry the tone
 * that lives at source second 1. Clip B is 44.1kHz where A is 48kHz.
 */
export function tonesTimelineSpec() {
  return {
    composition: { width: FIXTURE_TONES.width, height: FIXTURE_TONES.height },
    sources: [TONES_A, TONES_B],
    clips: [
      {
        sourceId: TONES_A.id,
        sourceInMicros: 1 * SECOND,
        sourceOutMicros: 3 * SECOND,
        timelineStartMicros: 0,
      },
      {
        sourceId: TONES_B.id,
        sourceInMicros: 0,
        sourceOutMicros: 2 * SECOND,
        timelineStartMicros: 3 * SECOND,
      },
    ],
  }
}

/**
 * What each second of tonesTimelineSpec should sound like, by timeline second.
 * Null means silence.
 *
 *   0s  clip A, source second 1  ->  400Hz
 *   1s  clip A, source second 2  ->  500Hz
 *   2s  gap                      ->  silence
 *   3s  clip B, source second 0  ->  900Hz
 *   4s  clip B, source second 1  ->  1000Hz
 */
export const TONES_EXPECTED_BY_SECOND = [400, 500, null, 900, 1000]

/** Every tone either fixture can produce, for the frequency search. */
export const ALL_TONE_HZ = [
  ...FIXTURE_TONES.toneHz,
  ...FIXTURE_TONES_44K.toneHz,
]
