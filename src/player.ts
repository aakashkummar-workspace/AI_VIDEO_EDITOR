import {
  SCHEDULE_LEAD_SECONDS,
  contextTimeFor,
  timelineMicrosAt,
  type ClockAnchor,
} from './audioSync'
import { frameCounts, installFrameTracking } from './frameTracker'
import { renderFrame, selectFrame } from './playback'
import { timelineDuration } from './timeline/operations'
import { emptyProject, type Project } from './timeline/types'
import type {
  AudioChunk,
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

/**
 * A decoded item waiting to be shown: the picture for every video row that has
 * to be drawn at that moment. An empty list is a gap, which paints black.
 */
type BufferedItem = {
  timelineMicros: number
  layers: { segmentId: string; frame: VideoFrame }[]
}

/** Frees every frame an item is carrying. */
function closeItem(item: BufferedItem): void {
  for (const layer of item.layers) layer.frame.close()
}

type Stats = {
  decoded: number
  drawn: number
  dropped: number
  peakBuffer: number
  /** Audio chunks whose scheduled start had already passed. Must stay zero. */
  audioUnderruns: number
  audioChunks: number
  /**
   * Largest gap seen between the audio clock and the frame actually on screen.
   * Recorded for the drift diagnostic (scripts/measure-drift.mjs); deliberately
   * not asserted in the suite, where it would flake on a loaded machine.
   */
  maxDriftMicros: number
}

const STATS_LOG_INTERVAL_MS = 1000

/** A stretch of decoded audio that is contiguous and uniform. */
type AudioRun = {
  startMicros: number
  sampleRate: number
  channels: number
  frames: number
  chunks: AudioChunk[]
}

/** Chunks whose start is this far from the previous end still count as joined. */
const RUN_JOIN_TOLERANCE_MICROS = 1000

/**
 * Groups decoded chunks into the longest runs that play back identically: same
 * rate, same channel count, each starting where the last one ended. A clip that
 * was never cut collapses to a single run.
 */
export function joinIntoRuns(chunks: AudioChunk[]): AudioRun[] {
  const runs: AudioRun[] = []

  for (const chunk of chunks) {
    const frames = chunk.planes[0]?.length ?? 0
    if (frames === 0) continue

    const current = runs.at(-1)
    const endsAt = current
      ? current.startMicros + (current.frames / current.sampleRate) * 1e6
      : 0

    const joins =
      current !== undefined &&
      current.sampleRate === chunk.sampleRate &&
      current.channels === chunk.planes.length &&
      Math.abs(chunk.timelineMicros - endsAt) <= RUN_JOIN_TOLERANCE_MICROS

    if (joins && current) {
      current.chunks.push(chunk)
      current.frames += frames
      continue
    }

    runs.push({
      startMicros: chunk.timelineMicros,
      sampleRate: chunk.sampleRate,
      channels: chunk.planes.length,
      frames,
      chunks: [chunk],
    })
  }

  return runs
}

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


  let stats: Stats = {
    decoded: 0,
    drawn: 0,
    dropped: 0,
    peakBuffer: 0,
    audioUnderruns: 0,
    audioChunks: 0,
    maxDriftMicros: 0,
  }
  let lastStatsLogMs = 0

  /**
   * The audio clock. Always running, even for a silent timeline: a silent
   * project schedules nothing but still reads its position from here.
   */
  const audio = new AudioContext()
  let anchor: ClockAnchor = { contextTime: 0, timelineMicros: 0 }
  let scheduled: AudioBufferSourceNode[] = []

  /** Collects the timeline's audio while an export is being prepared. */
  let exportAudio: {
    chunks: AudioChunk[]
    resolve: (chunks: AudioChunk[]) => void
  } | null = null

  function stopScheduledAudio() {
    for (const node of scheduled) {
      try {
        node.stop()
      } catch {
        // Already finished; nothing to stop.
      }
      node.disconnect()
    }
    scheduled = []
  }

  /** Schedules one decoded chunk at the moment its timeline position falls. */
  function scheduleChunk(chunk: AudioChunk) {
    const frames = chunk.planes[0]?.length ?? 0
    if (frames === 0) return

    // The buffer keeps its own sample rate; the graph resamples on playback,
    // which is how sources of different rates play together.
    const buffer = audio.createBuffer(
      chunk.planes.length,
      frames,
      chunk.sampleRate,
    )
    for (let channel = 0; channel < chunk.planes.length; channel++) {
      buffer.copyToChannel(chunk.planes[channel]!, channel)
    }

    const node = audio.createBufferSource()
    node.buffer = buffer
    node.connect(audio.destination)

    const at = contextTimeFor(anchor, chunk.timelineMicros)
    if (at < audio.currentTime) {
      stats.audioUnderruns++
      node.start()
    } else {
      node.start(at)
    }

    stats.audioChunks++
    scheduled.push(node)
    node.onended = () => {
      node.disconnect()
      scheduled = scheduled.filter((candidate) => candidate !== node)
    }
  }

  type FrameCountReport = {
    worker: { created: number; closed: number }
    main: { created: number; closed: number }
    openSources: number
  }
  let pendingFrameCounts: ((report: FrameCountReport) => void) | null = null
  const pendingProbes = new Map<string, (geometry: SourceGeometry) => void>()

  function send(message: MainToWorker, transfer: Transferable[] = []) {
    worker.postMessage(message, transfer)
  }

  function resetStats() {
    stats = {
      decoded: 0,
      drawn: 0,
      dropped: 0,
      peakBuffer: 0,
      audioUnderruns: 0,
      audioChunks: 0,
      maxDriftMicros: 0,
    }
    lastStatsLogMs = 0
  }

  function logStats(label: string) {
    console.log(
      `[playback] ${label} decoded=${stats.decoded} drawn=${stats.drawn}` +
        ` dropped=${stats.dropped} buffer=${buffer.length}` +
        ` peakBuffer=${stats.peakBuffer} audioChunks=${stats.audioChunks}` +
        ` audioUnderruns=${stats.audioUnderruns}`,
    )
  }

  /** Closes and discards everything still buffered. */
  function flushBuffer() {
    for (const item of buffer) {
      closeItem(item)
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
      renderFrame(
        context2d(),
        project,
        item.timelineMicros,
        new Map(item.layers.map((layer) => [layer.segmentId, layer.frame])),
      )
    } finally {
      closeItem(item)
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
    stopScheduledAudio()
    playing = false
    currentMicros = timelineDuration(project)
    callbacks.onTime(currentMicros)
    callbacks.onPlayingChange(false)
    logStats('finished')
  }

  function tick() {
    const nowMs = performance.now()

    // Position comes from the audio clock, never from performance.now(): the
    // two drift, and audio is the one that cannot be nudged without a click.
    const targetMicros = timelineMicrosAt(anchor, audio.currentTime)
    const { drawIndex } = selectFrame(buffer, targetMicros)

    if (drawIndex >= 0) {
      for (let i = 0; i < drawIndex; i++) {
        closeItem(buffer[i]!)
        stats.dropped++
      }

      const chosen = buffer[drawIndex]!
      paint(chosen)
      stats.drawn++
      stats.maxDriftMicros = Math.max(
        stats.maxDriftMicros,
        Math.abs(targetMicros - chosen.timelineMicros),
      )

      const consumed = drawIndex + 1
      buffer.splice(0, consumed)
      send({ type: 'consumed', generation, count: consumed })
    }

    // The playhead follows the clock, not the last frame drawn. A gap emits
    // one black item and then nothing, so tracking frames would freeze the
    // playhead for the length of the gap and then jump.
    currentMicros = Math.min(
      Math.max(targetMicros, 0),
      timelineDuration(project),
    )
    callbacks.onTime(currentMicros)

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

  /**
   * Renders the whole timeline's audio into one buffer.
   *
   * Every chunk is placed at an absolute offset derived from its timeline
   * position, so a clip boundary is two buffers that happen to abut and a gap
   * is simply nothing scheduled. Sources of different rates are resampled by
   * the graph on the way in.
   */
  async function renderAudioMix(): Promise<{
    sampleRate: number
    planes: Float32Array<ArrayBuffer>[]
  } | null> {
    const durationMicros = timelineDuration(project)
    if (durationMicros <= 0) return null

    const decodeStarted = performance.now()
    const chunks = await new Promise<AudioChunk[]>((resolve) => {
      exportAudio = { chunks: [], resolve }
      send({ type: 'decodeAudioForExport', generation })
    })
    const decodedMs = performance.now() - decodeStarted
    if (chunks.length === 0) return null

    const sampleRate = chunks[0]!.sampleRate
    const channels = Math.max(...chunks.map((chunk) => chunk.planes.length))
    const frames = Math.ceil((durationMicros / 1e6) * sampleRate)

    const offline = new OfflineAudioContext(channels, frames, sampleRate)

    // One node per decoded packet renders unusably slowly - a 2 minute
    // timeline is ~5900 packets, and OfflineAudioContext took 80 seconds to
    // render that many. Contiguous packets of the same shape are joined into
    // runs first, so an uncut clip becomes a single node.
    const runs = joinIntoRuns(chunks)

    for (const run of runs) {
      const buffer = offline.createBuffer(
        run.channels,
        run.frames,
        run.sampleRate,
      )

      for (let channel = 0; channel < run.channels; channel++) {
        const target = buffer.getChannelData(channel)
        let offset = 0
        for (const chunk of run.chunks) {
          const plane = chunk.planes[channel] ?? chunk.planes[0]!
          target.set(plane, offset)
          offset += plane.length
        }
      }

      const node = offline.createBufferSource()
      node.buffer = buffer
      node.connect(offline.destination)
      node.start(run.startMicros / 1e6)
    }

    const renderStarted = performance.now()
    const rendered = await offline.startRendering()
    console.log(
      `[export] audio: ${chunks.length} chunks joined into ${runs.length}` +
        ` runs, decoded in ${decodedMs.toFixed(0)}ms, scheduled in` +
        ` ${(renderStarted - decodeStarted - decodedMs).toFixed(0)}ms,` +
        ` rendered in ${(performance.now() - renderStarted).toFixed(0)}ms`,
    )
    const planes: Float32Array<ArrayBuffer>[] = []
    for (let channel = 0; channel < rendered.numberOfChannels; channel++) {
      planes.push(
        rendered.getChannelData(channel).slice() as Float32Array<ArrayBuffer>,
      )
    }

    return { sampleRate, planes }
  }

  worker.addEventListener('message', (event: MessageEvent<WorkerToMain>) => {
    const message = event.data

    if (message.type === 'frame') {
      if (message.generation !== generation) {
        for (const layer of message.layers) layer.frame.close()
        return
      }

      const item: BufferedItem = {
        timelineMicros: message.timelineMicros,
        layers: message.layers,
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

    if (message.type === 'audioChunk') {
      if (message.mode === 'export') {
        exportAudio?.chunks.push(message.chunk)
        return
      }

      if (message.generation !== generation || !playing) return
      scheduleChunk(message.chunk)
      send({ type: 'audioConsumed', generation, count: 1 })
      return
    }

    if (message.type === 'audioEnd') {
      if (message.mode === 'export' && exportAudio) {
        const collected = exportAudio.chunks
        const resolve = exportAudio.resolve
        exportAudio = null
        resolve(collected)
      }
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
        pendingFrameCounts?.({
          worker: message.counts,
          main: frameCounts(),
          openSources: message.openSources,
        })
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

      // Assigning width or height resets a canvas even when the value is
      // unchanged, so only touch them when the composition really changed.
      // Otherwise every edit blanks the preview for a frame and a drag flickers.
      if (canvas.width !== next.composition.width) {
        canvas.width = next.composition.width
      }
      if (canvas.height !== next.composition.height) {
        canvas.height = next.composition.height
      }

      send({ type: 'setProject', generation, project: next })
    },

    /** Renders a single frame at a timeline position through the preview path. */
    seek(timelineMicros: number) {
      stopLoop()
      stopScheduledAudio()
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
      stopScheduledAudio()
      resetStats()

      // Reaching the end and pressing play again restarts from the top.
      if (currentMicros >= duration) {
        currentMicros = 0
      }

      playing = true

      // A context can be suspended by the autoplay policy until a gesture;
      // play() is one, so this is where it wakes up.
      void audio.resume()

      // Anchor a little ahead, so the first buffers have somewhere to land
      // rather than arriving already late.
      anchor = {
        contextTime: audio.currentTime + SCHEDULE_LEAD_SECONDS,
        timelineMicros: currentMicros,
      }

      callbacks.onPlayingChange(true)
      send({ type: 'play', generation, fromTimelineMicros: currentMicros })
      rafId = requestAnimationFrame(tick)
    },

    pause() {
      if (!playing) return

      stopLoop()
      stopScheduledAudio()
      playing = false
      generation++
      send({ type: 'stop', generation })
      flushBuffer()
      callbacks.onPlayingChange(false)
      logStats('paused')
    },

    async exportMp4() {
      if (exporting || timelineDuration(project) === 0) return

      stopLoop()
      stopScheduledAudio()
      generation++
      if (playing) {
        playing = false
        callbacks.onPlayingChange(false)
      }
      flushBuffer()

      exporting = true
      callbacks.onExportProgress(0)

      try {
        // The mix is rendered offline first: OfflineAudioContext exists only
        // on this thread, and the worker cannot mux what it does not have.
        const mixed = await renderAudioMix()
        send(
          { type: 'export', generation, audio: mixed },
          mixed ? mixed.planes.map((plane) => plane.buffer as ArrayBuffer) : [],
        )
      } catch (err) {
        exporting = false
        callbacks.onExportProgress(null)
        callbacks.onError(err instanceof Error ? err.message : String(err))
      }
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
      stopScheduledAudio()
      generation++
      flushBuffer()
      void audio.close()
      worker.terminate()
    },
  }
}
