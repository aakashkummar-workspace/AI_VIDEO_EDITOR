/**
 * Messages between the UI thread and the decode worker.
 *
 * `generation` guards against stale work: every play/seek/stop bumps it, and
 * frames tagged with an old generation are closed on arrival instead of drawn.
 */

/** How many decoded frames the worker keeps in flight ahead of playback. */
export const BUFFER_TARGET = 8

export type MainToWorker =
  | { type: 'load'; generation: number; file: File }
  | { type: 'seek'; generation: number; micros: number }
  | { type: 'play'; generation: number; fromMicros: number }
  | { type: 'stop'; generation: number }
  | { type: 'consumed'; generation: number; count: number }

export type WorkerToMain =
  | {
      type: 'loaded'
      generation: number
      width: number
      height: number
      rotation: 0 | 90 | 180 | 270
      durationMicros: number
    }
  | {
      type: 'frame'
      generation: number
      mode: 'seek' | 'play'
      timestampMicros: number
      frame: VideoFrame
    }
  | { type: 'end'; generation: number }
  | { type: 'error'; generation: number; message: string }
