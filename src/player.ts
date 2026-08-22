import type { Rotation } from 'mediabunny'
import { drawFrame, selectFrame } from './playback'
import type { MainToWorker, WorkerToMain } from './workerProtocol'

export type LoadedInfo = {
  width: number
  height: number
  durationMicros: number
}

export type PlayerCallbacks = {
  onLoaded: (info: LoadedInfo) => void
  onTime: (micros: number) => void
  onPlayingChange: (playing: boolean) => void
  onError: (message: string) => void
}

type BufferedFrame = { timestampMicros: number; frame: VideoFrame }

type Stats = {
  decoded: number
  drawn: number
  dropped: number
  peakBuffer: number
}

const STATS_LOG_INTERVAL_MS = 1000

/**
 * Owns the decode worker and the requestAnimationFrame playback loop.
 * The UI thread never decodes: it only receives frames and draws them.
 */
export function createPlayer(
  canvas: HTMLCanvasElement,
  callbacks: PlayerCallbacks,
) {
  const worker = new Worker(new URL('./videoWorker.ts', import.meta.url), {
    type: 'module',
  })

  const buffer: BufferedFrame[] = []

  let generation = 0
  let rotation: Rotation = 0
  let width = 0
  let height = 0
  let durationMicros = 0

  let playing = false
  let streamEnded = false
  let currentMicros = 0
  let rafId: number | null = null

  /** Wall-clock and media anchors; playback time is derived from these. */
  let wallStartMs = 0
  let mediaStartMicros = 0
  let clockSynced = false

  let stats: Stats = { decoded: 0, drawn: 0, dropped: 0, peakBuffer: 0 }
  let lastStatsLogMs = 0

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
    for (const buffered of buffer) {
      buffered.frame.close()
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

  function paint(frame: VideoFrame) {
    try {
      drawFrame(context2d(), frame, width, height, rotation)
    } finally {
      frame.close()
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
    currentMicros = durationMicros
    callbacks.onTime(currentMicros)
    callbacks.onPlayingChange(false)
    logStats('finished')
  }

  function tick() {
    const nowMs = performance.now()

    // Anchor the clock to the first frame that actually arrives, so decoder
    // start-up latency is not counted as elapsed playback time.
    if (!clockSynced && buffer.length > 0) {
      mediaStartMicros = buffer[0]!.timestampMicros
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
          buffer[i]!.frame.close()
          stats.dropped++
        }

        const chosen = buffer[drawIndex]!
        paint(chosen.frame)
        stats.drawn++
        currentMicros = chosen.timestampMicros

        const consumed = drawIndex + 1
        buffer.splice(0, consumed)
        send({ type: 'consumed', generation, count: consumed })
        callbacks.onTime(currentMicros)
      }
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
        message.frame.close()
        return
      }

      if (message.mode === 'seek') {
        paint(message.frame)
        currentMicros = message.timestampMicros
        callbacks.onTime(currentMicros)
        return
      }

      stats.decoded++
      buffer.push({
        timestampMicros: message.timestampMicros,
        frame: message.frame,
      })
      stats.peakBuffer = Math.max(stats.peakBuffer, buffer.length)
      return
    }

    if (message.generation !== generation) return

    switch (message.type) {
      case 'loaded':
        width = message.width
        height = message.height
        rotation = message.rotation
        durationMicros = message.durationMicros
        canvas.width = width
        canvas.height = height
        currentMicros = 0
        callbacks.onLoaded({ width, height, durationMicros })
        send({ type: 'seek', generation, micros: 0 })
        return

      case 'end':
        streamEnded = true
        return

      case 'error':
        stopLoop()
        playing = false
        callbacks.onPlayingChange(false)
        callbacks.onError(message.message)
        return
    }
  })

  worker.addEventListener('error', (event) => {
    callbacks.onError(event.message || 'The decode worker failed.')
  })

  return {
    load(file: File) {
      stopLoop()
      generation++
      playing = false
      streamEnded = false
      flushBuffer()
      resetStats()
      send({ type: 'load', generation, file })
    },

    play() {
      if (playing || durationMicros === 0) return

      generation++
      streamEnded = false
      flushBuffer()
      resetStats()

      // Reaching the end and pressing play again restarts from the top.
      if (currentMicros >= durationMicros) {
        currentMicros = 0
      }

      playing = true
      clockSynced = false
      mediaStartMicros = currentMicros
      wallStartMs = performance.now()

      callbacks.onPlayingChange(true)
      send({ type: 'play', generation, fromMicros: currentMicros })
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

    destroy() {
      stopLoop()
      generation++
      flushBuffer()
      worker.terminate()
    },
  }
}
