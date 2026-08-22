import { frameCounts, installFrameTracking } from './frameTracker'
import { renderFrame, selectFrame } from './playback'
import { timelineDuration } from './timeline/operations'
import { emptyProject, type Project } from './timeline/types'
import type {
  MainToWorker,
  SourceGeometry,
  WorkerToMain,
} from './workerProtocol'

export type PlayerCallbacks = {
  /** Playhead position, in TIMELINE microseconds. */
  onTime: (timelineMicros: number) => void
  onPlayingChange: (playing: boolean) => void
  /** Export progress from 0 to 1, or null when no export is running. */
  onExportProgress: (progress: number | null) => void
  onExported: (buffer: ArrayBuffer) => void
  onError: (message: string) => void
}

export type PlayerOptions = {
  /** Test-only: count VideoFrame creations and closes on both threads. */
  instrument?: boolean
}

/** A decoded item waiting to be shown: a frame, or null where a gap is. */
type BufferedItem = { timelineMicros: number; frame: VideoFrame | null }

type Stats = {
  decoded: number
  drawn: number
  dropped: number
  peakBuffer: number
}

const STATS_LOG_INTERVAL_MS = 1000

/**
 * Owns the decode worker and the requestAnimationFrame playback loop.
 *
 * The player's input is the project, not a file. Everything it reports and
 * everything it is asked for is in timeline microseconds; resolving that to a
 * source and a source timestamp is the worker's job.
 */
export function createPlayer(
  canvas: HTMLCanvasElement,
  callbacks: PlayerCallbacks,
  options: PlayerOptions = {},
) {
  if (options.instrument) {
    installFrameTracking('main')
  }

  const worker = new Worker(new URL('./videoWorker.ts', import.meta.url), {
    type: 'module',
    name: options.instrument ? 'instrumented' : 'video-worker',
  })

  const buffer: BufferedItem[] = []

  let project: Project = emptyProject()
  let generation = 0

  let playing = false
  let exporting = false
  let streamEnded = false
  let currentMicros = 0
  let rafId: number | null = null

  /** Wall-clock and media anchors; playback time is derived from these. */
  let wallStartMs = 0
  let mediaStartMicros = 0
  let clockSynced = false

  let stats: Stats = { decoded: 0, drawn: 0, dropped: 0, peakBuffer: 0 }
  let lastStatsLogMs = 0

  type FrameCountReport = {
    worker: { created: number; closed: number }
    main: { created: number; closed: number }
  }
  let pendingFrameCounts: ((report: FrameCountReport) => void) | null = null
  const pendingProbes = new Map<string, (geometry: SourceGeometry) => void>()

  function send(message: MainToWorker, transfer: Transferable[] = []) {
    worker.postMessage(message, transfer)
  }

  function resetStats() {
    stats = { decoded: 0, drawn: 0, dropped: 0, peakBuffer: 0 }
    lastStatsLogMs = 0
  }

  function logStats(label: string) {
    console.log(
      `[playback] ${label} decoded=${stats.decoded} drawn=${stats.drawn}` +
        ` dropped=${stats.dropped} buffer=${buffer.length}` +
        ` peakBuffer=${stats.peakBuffer}`,
    )
  }

  /** Closes and discards everything still buffered. */
  function flushBuffer() {
    for (const item of buffer) {
      item.frame?.close()
      stats.dropped++
    }
    buffer.length = 0
  }

  function context2d(): CanvasRenderingContext2D {
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Could not get a 2D context from the canvas.')
    }
    return context
  }

  /** The one render call on this thread. */
  function paint(item: BufferedItem) {
    try {
      renderFrame(context2d(), project, item.timelineMicros, item.frame)
    } finally {
      item.frame?.close()
    }
  }

  function stopLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }

  function finish() {
    stopLoop()
    playing = false
    currentMicros = timelineDuration(project)
    callbacks.onTime(currentMicros)
    callbacks.onPlayingChange(false)
    logStats('finished')
  }

  function tick() {
    const nowMs = performance.now()

    // Anchor the clock to the first item that actually arrives, so decoder
    // start-up latency is not counted as elapsed playback time.
    if (!clockSynced && buffer.length > 0) {
      mediaStartMicros = buffer[0]!.timelineMicros
      wallStartMs = nowMs
      clockSynced = true
      lastStatsLogMs = nowMs
    }

    if (clockSynced) {
      const targetMicros =
        mediaStartMicros + Math.round((nowMs - wallStartMs) * 1000)
      const { drawIndex } = selectFrame(buffer, targetMicros)

      if (drawIndex >= 0) {
        for (let i = 0; i < drawIndex; i++) {
          buffer[i]!.frame?.close()
          stats.dropped++
        }

        const chosen = buffer[drawIndex]!
        paint(chosen)
        stats.drawn++

        const consumed = drawIndex + 1
        buffer.splice(0, consumed)
        send({ type: 'consumed', generation, count: consumed })
      }

      // The playhead follows the clock, not the last frame drawn. A gap emits
      // one black item and then nothing, so tracking frames would freeze the
      // playhead for the length of the gap and then jump.
      currentMicros = Math.min(targetMicros, timelineDuration(project))
      callbacks.onTime(currentMicros)
    }

    if (nowMs - lastStatsLogMs >= STATS_LOG_INTERVAL_MS) {
      lastStatsLogMs = nowMs
      logStats('playing')
    }

    if (streamEnded && buffer.length === 0) {
      finish()
      return
    }

    rafId = requestAnimationFrame(tick)
  }

  worker.addEventListener('message', (event: MessageEvent<WorkerToMain>) => {
    const message = event.data

    if (message.type === 'frame') {
      if (message.generation !== generation) {
        message.frame?.close()
        return
      }

      const item: BufferedItem = {
        timelineMicros: message.timelineMicros,
        frame: message.frame,
      }

      if (message.mode === 'seek') {
        paint(item)
        currentMicros = item.timelineMicros
        callbacks.onTime(currentMicros)
        return
      }

      stats.decoded++
      buffer.push(item)
      stats.peakBuffer = Math.max(stats.peakBuffer, buffer.length)
      return
    }

    if (message.type === 'sourceProbed') {
      pendingProbes.get(message.sourceId)?.(message.geometry)
      pendingProbes.delete(message.sourceId)
      return
    }

    if (message.generation !== generation) return

    switch (message.type) {
      case 'end':
        streamEnded = true
        return

      case 'exportProgress':
        callbacks.onExportProgress(message.progress)
        return

      case 'exported':
        exporting = false
        callbacks.onExportProgress(null)
        callbacks.onExported(message.buffer)
        return

      case 'frameCounts':
        pendingFrameCounts?.({ worker: message.counts, main: frameCounts() })
        pendingFrameCounts = null
        return

      case 'error':
        stopLoop()
        playing = false
        exporting = false
        callbacks.onExportProgress(null)
        callbacks.onPlayingChange(false)
        callbacks.onError(message.message)
        return
    }
  })

  worker.addEventListener('error', (event) => {
    callbacks.onError(event.message || 'The decode worker failed.')
  })

  return {
    /** Opens a file in the worker and reports what the UI needs to add it. */
    probeSource(sourceId: string, file: File): Promise<SourceGeometry> {
      return new Promise((resolve) => {
        pendingProbes.set(sourceId, resolve)
        generation++
        send({ type: 'probeSource', generation, sourceId, file })
      })
    },

    /** Hands the worker the project it should render. */
    setProject(next: Project) {
      stopLoop()
      generation++
      playing = false
      exporting = false
      streamEnded = false
      flushBuffer()
      resetStats()

      project = next
      canvas.width = next.composition.width
      canvas.height = next.composition.height

      send({ type: 'setProject', generation, project: next })
    },

    /** Renders a single frame at a timeline position through the preview path. */
    seek(timelineMicros: number) {
      stopLoop()
      generation++
      if (playing) {
        playing = false
        callbacks.onPlayingChange(false)
      }
      flushBuffer()
      send({ type: 'seek', generation, timelineMicros })
    },

    play() {
      if (playing || exporting) return

      const duration = timelineDuration(project)
      if (duration === 0) return

      generation++
      streamEnded = false
      flushBuffer()
      resetStats()

      // Reaching the end and pressing play again restarts from the top.
      if (currentMicros >= duration) {
        currentMicros = 0
      }

      playing = true
      clockSynced = false
      mediaStartMicros = currentMicros
      wallStartMs = performance.now()

      callbacks.onPlayingChange(true)
      send({ type: 'play', generation, fromTimelineMicros: currentMicros })
      rafId = requestAnimationFrame(tick)
    },

    pause() {
      if (!playing) return

      stopLoop()
      playing = false
      generation++
      send({ type: 'stop', generation })
      flushBuffer()
      callbacks.onPlayingChange(false)
      logStats('paused')
    },

    exportMp4() {
      if (exporting || timelineDuration(project) === 0) return

      stopLoop()
      generation++
      if (playing) {
        playing = false
        callbacks.onPlayingChange(false)
      }
      flushBuffer()

      exporting = true
      callbacks.onExportProgress(0)
      send({ type: 'export', generation })
    },

    stats(): Stats {
      return { ...stats }
    },

    /** Test-only: resolves with the VideoFrame counts from both threads. */
    frameCounts(): Promise<FrameCountReport> {
      return new Promise((resolve) => {
        pendingFrameCounts = resolve
        send({ type: 'frameCounts', generation })
      })
    },

    destroy() {
      stopLoop()
      generation++
      flushBuffer()
      worker.terminate()
    },
  }
}
