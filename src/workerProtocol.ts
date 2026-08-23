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
 * Hard cap on buffered FRAMES, so the time-based target above cannot blow up
 * memory on large frames. 24 frames covers 400ms at 60fps; at 4K that is
 * roughly 300MB of decoded frames worst case, which is the real limit here.
 *
 * Frames, not items: one render item carries one frame per video row that has
 * to be drawn, so three stacked rows put three frames in flight per item. This
 * bound is about memory, and memory is counted in frames.
 */
export const BUFFER_MAX_FRAMES = 24

/**
 * Hard cap on buffered ITEMS, which the frame cap alone does not give.
 *
 * A stretch of gaps yields items carrying no frames at all; without this they
 * would never fill the buffer and the walk would run away from the playhead.
 */
export const BUFFER_MAX_ITEMS = 24

/** Decoded PCM for one stretch of the timeline. Planes are per channel. */
export type AudioChunk = {
  timelineMicros: number
  sampleRate: number
  /** Explicitly ArrayBuffer-backed, so copyToChannel accepts them. */
  planes: Float32Array<ArrayBuffer>[]
}

/**
 * How finely a waveform is measured, in buckets per second.
 *
 * Fifty is about one bucket per two pixels at the default zoom, which is as
 * much detail as a timeline block can show. A three minute song is then nine
 * thousand numbers, which is nothing to keep and nothing to draw.
 */
export const WAVEFORM_BUCKETS_PER_SECOND = 50

/** How many undelivered audio chunks the worker keeps ahead of the playhead. */
export const AUDIO_BUFFER_MAX_CHUNKS = 64

export type SourceGeometry = {
  durationMicros: number
  /** False for a file that carries only sound, which belongs on an audio row. */
  hasVideo: boolean
  /** Zero when there is no picture. */
  width: number
  height: number
  rotation: Rotation
  /** Null when the source carries no audio track. */
  audio: { sampleRate: number; channels: number } | null
}

export type MainToWorker =
  /** Opens a file and reports its geometry, so the UI can build a Source. */
  | { type: 'probeSource'; generation: number; sourceId: string; file: File }
  | { type: 'setProject'; generation: number; project: Project }
  | { type: 'seek'; generation: number; timelineMicros: number }
  | { type: 'play'; generation: number; fromTimelineMicros: number }
  | { type: 'stop'; generation: number }
  | { type: 'consumed'; generation: number; count: number }
  | { type: 'audioConsumed'; generation: number; count: number }
  /** Decodes the whole timeline's audio, for the offline export mix. */
  | { type: 'decodeAudioForExport'; generation: number }
  | {
      type: 'export'
      generation: number
      /** The rendered mix to mux in, or null for a silent timeline. */
      audio: {
        sampleRate: number
        planes: Float32Array<ArrayBuffer>[]
      } | null
    }
  | { type: 'frameCounts'; generation: number }
  /** Asks for the waveform of a source, which is measured once and kept. */
  | { type: 'peaks'; generation: number; sourceId: string }

export type WorkerToMain =
  | {
      type: 'sourceProbed'
      generation: number
      sourceId: string
      geometry: SourceGeometry
    }
  /**
   * One render item: the decoded picture for every video row that has to be
   * drawn at this moment, bottom of the stack first. An empty list is a moment
   * with no picture at all, which the render function paints black.
   */
  | {
      type: 'frame'
      generation: number
      mode: 'seek' | 'play'
      timelineMicros: number
      layers: { segmentId: string; frame: VideoFrame }[]
    }
  | {
      type: 'audioChunk'
      generation: number
      mode: 'play' | 'export'
      chunk: AudioChunk
    }
  | { type: 'audioEnd'; generation: number; mode: 'play' | 'export' }
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
  | {
      type: 'peaks'
      generation: number
      sourceId: string
      /** Loudest sample in each bucket, from 0 to 1. Empty when silent. */
      peaks: Float32Array<ArrayBuffer>
      bucketsPerSecond: number
    }
  | { type: 'error'; generation: number; message: string }
