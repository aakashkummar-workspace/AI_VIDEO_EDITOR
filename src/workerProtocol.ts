import type { Project, Rotation } from './timeline/types'

/**
 * Messages between the UI thread and the decode worker.
 *
 * Everything here speaks TIMELINE microseconds. Mapping a timeline position to
 * a source position is the worker's job, via clipAt.
 *
 * `generation` guards against stale work: every play/seek/stop bumps it, and
 * frames tagged with an old generation are closed on arrival instead of drawn.
 */

/**
 * How far ahead of the playhead the worker decodes.
 *
 * The worst warm seek measured was 95ms - a 1280x720 clip with a single
 * keyframe across 300 frames, which is about as bad as a GOP gets. See
 * `node scripts/measure-seek.mjs`. 400ms leaves roughly 4x margin, so the
 * seek that happens when playback crosses a clip boundary finishes well
 * before the playhead arrives and no pre-roll scheduler is needed: this
 * buffer IS the pre-roll.
 *
 * Those measurements are synthetic H.264 only. Re-measure before trusting
 * this margin on real camera footage, 60fps, or 4K.
 */
export const BUFFER_AHEAD_MICROS = 400_000

/**
 * Hard cap on buffered frames, so the time-based target above cannot blow up
 * memory on large frames. 24 frames covers 400ms at 60fps; at 4K that is
 * roughly 300MB of decoded frames worst case, which is the real limit here.
 */
export const BUFFER_MAX_FRAMES = 24

export type SourceGeometry = {
  durationMicros: number
  width: number
  height: number
  rotation: Rotation
}

export type MainToWorker =
  /** Opens a file and reports its geometry, so the UI can build a Source. */
  | { type: 'probeSource'; generation: number; sourceId: string; file: File }
  | { type: 'setProject'; generation: number; project: Project }
  | { type: 'seek'; generation: number; timelineMicros: number }
  | { type: 'play'; generation: number; fromTimelineMicros: number }
  | { type: 'stop'; generation: number }
  | { type: 'consumed'; generation: number; count: number }
  | { type: 'export'; generation: number }
  | { type: 'frameCounts'; generation: number }

export type WorkerToMain =
  | {
      type: 'sourceProbed'
      generation: number
      sourceId: string
      geometry: SourceGeometry
    }
  /**
   * One render item. `frame` is null where the timeline has no clip, which the
   * render function paints black.
   */
  | {
      type: 'frame'
      generation: number
      mode: 'seek' | 'play'
      timelineMicros: number
      frame: VideoFrame | null
    }
  | { type: 'end'; generation: number }
  | { type: 'exportProgress'; generation: number; progress: number }
  | { type: 'exported'; generation: number; buffer: ArrayBuffer }
  | {
      type: 'frameCounts'
      generation: number
      counts: { created: number; closed: number }
      /** How many Inputs the worker currently holds open. */
      openSources: number
    }
  | { type: 'error'; generation: number; message: string }
