/**
 * Browser-side driver for the Playwright tests. It exercises the real player
 * and the real worker; it does not reimplement any of the rendering.
 */
import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from 'mediabunny'
import { createPlayer } from '../../src/player'
import { microsToSeconds } from '../../src/playback'
import { timelineDuration } from '../../src/timeline/operations'
import {
  clearSourceFiles,
  registerSourceFile,
} from '../../src/timeline/sourceRegistry'
import { useTimelineStore } from '../../src/timeline/store'

const canvas = document.getElementById('canvas') as HTMLCanvasElement

let lastError: string | null = null
let exported: ArrayBuffer | null = null

/** Every playhead position reported during the last playThrough. */
let observedTimes: number[] = []
let recordTimes = false

let notifyTime: (() => void) | null = null
let notifyStopped: (() => void) | null = null
let notifyExported: (() => void) | null = null

const player = createPlayer(
  canvas,
  {
    onTime: (timelineMicros) => {
      if (recordTimes) observedTimes.push(timelineMicros)
      notifyTime?.()
      notifyTime = null
    },
    onPlayingChange: (playing) => {
      if (!playing) {
        notifyStopped?.()
        notifyStopped = null
      }
    },
    onExportProgress: () => {},
    onExported: (buffer) => {
      exported = buffer
      notifyExported?.()
      notifyExported = null
    },
    onError: (message) => {
      lastError = message
      notifyTime?.()
      notifyStopped?.()
      notifyExported?.()
      notifyTime = notifyStopped = notifyExported = null
    },
  },
  { instrument: true },
)

function nextTime() {
  return new Promise<void>((resolve) => {
    notifyTime = resolve
  })
}

function throwIfErrored() {
  if (lastError !== null) {
    const message = lastError
    lastError = null
    throw new Error(message)
  }
}

/**
 * Encodes a deterministic test clip with WebCodecs. Every frame differs from
 * its neighbours (moving bar, stepping background, frame number) so that a
 * comparison against the wrong frame cannot pass by accident.
 */
async function generateFixture(options: {
  frames: number
  width: number
  height: number
  fps: number
  /** Shifts the palette, so two fixtures are never mistaken for each other. */
  hueOffset?: number
  /** Draws the moving marker as a bar or a block, likewise. */
  marker?: 'bar' | 'block'
  /**
   * One sine frequency per whole second of the clip. A decoded window can then
   * be traced back to the second it came from, which is what makes audio sync
   * measurable rather than a matter of listening.
   */
  toneHz?: number[]
  audioSampleRate?: number
}) {
  const { frames, width, height, fps } = options
  const hueOffset = options.hueOffset ?? 0
  const marker = options.marker ?? 'bar'
  const format = new Mp4OutputFormat()

  const codec = await getFirstEncodableVideoCodec(
    format.getSupportedVideoCodecs(),
    { width, height, quality: QUALITY_HIGH },
  )
  if (!codec) throw new Error('No encodable codec for the fixture.')

  const surface = new OffscreenCanvas(width, height)
  const context = surface.getContext('2d')
  if (!context) throw new Error('No 2D context for the fixture.')

  const output = new Output({ format, target: new BufferTarget() })
  const source = new CanvasSource(surface, { codec, quality: QUALITY_HIGH })
  output.addVideoTrack(source)

  const toneHz = options.toneHz
  const audioSampleRate = options.audioSampleRate ?? 48_000
  let audioSource: AudioBufferSource | null = null

  if (toneHz && toneHz.length > 0) {
    const audioCodec = await getFirstEncodableAudioCodec(
      format.getSupportedAudioCodecs(),
      { numberOfChannels: 1, sampleRate: audioSampleRate },
    )
    if (!audioCodec) throw new Error('No encodable audio codec for the fixture.')

    audioSource = new AudioBufferSource({
      codec: audioCodec,
      quality: QUALITY_HIGH,
    })
    output.addAudioTrack(audioSource)
  }

  await output.start()

  if (audioSource && toneHz) {
    // One buffer per second, each a pure tone, so the timeline second a decoded
    // window belongs to can be read straight off its frequency.
    const context = new OfflineAudioContext(1, audioSampleRate, audioSampleRate)
    const seconds = Math.ceil(frames / fps)

    for (let second = 0; second < seconds; second++) {
      const hz = toneHz[second % toneHz.length]!
      const buffer = context.createBuffer(1, audioSampleRate, audioSampleRate)
      const channel = buffer.getChannelData(0)

      for (let i = 0; i < channel.length; i++) {
        channel[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / audioSampleRate)
      }

      await audioSource.add(buffer)
    }
  }

  for (let index = 0; index < frames; index++) {
    // Flat blocks keep the clip small and compress near-losslessly.
    context.fillStyle = `hsl(${(index * 7 + hueOffset) % 360} 70% 45%)`
    context.fillRect(0, 0, width, height)

    context.fillStyle = '#ffffff'
    if (marker === 'bar') {
      context.fillRect((index * 3) % width, 0, 24, height)
    } else {
      context.fillRect(
        (index * 5) % Math.max(1, width - 40),
        height - 48,
        40,
        40,
      )
    }

    context.fillStyle = '#000000'
    context.font = 'bold 64px monospace'
    context.textBaseline = 'top'
    context.fillText(String(index), 12, 12)

    await source.add(index / fps, 1 / fps)
  }

  audioSource?.close()
  await output.finalize()
  const buffer = output.target.buffer
  if (!buffer) throw new Error('The fixture produced no data.')

  return Array.from(new Uint8Array(buffer))
}

export type ProjectSpec = {
  composition: { width: number; height: number }
  sources: { id: string; url: string }[]
  clips: {
    sourceId: string
    sourceInMicros: number
    sourceOutMicros: number
    timelineStartMicros: number
  }[]
}

async function fetchAsFile(url: string, name: string): Promise<File> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not fetch ${url}.`)
  return new File([await response.arrayBuffer()], name, { type: 'video/mp4' })
}

/** Builds a project from `spec`, however many sources it names, and loads it. */
async function loadProject(spec: ProjectSpec) {
  const store = useTimelineStore.getState()
  store.reset()
  clearSourceFiles()
  lastError = null

  store.setComposition(spec.composition)

  for (const source of spec.sources) {
    const file = await fetchAsFile(source.url, `${source.id}.mp4`)
    registerSourceFile(source.id, file)

    const geometry = await player.probeSource(source.id, file)
    store.addSource({
      id: source.id,
      name: source.url.split('/').pop() ?? source.id,
      durationMicros: geometry.durationMicros,
      width: geometry.width,
      height: geometry.height,
      rotation: geometry.rotation,
    })
  }

  spec.clips.forEach((clip, index) =>
    store.addClip({ id: `clip-${index}`, ...clip }),
  )

  const project = useTimelineStore.getState().project
  player.setProject(project)
  throwIfErrored()

  return {
    width: project.composition.width,
    height: project.composition.height,
    durationMicros: timelineDuration(project),
  }
}

/** Loads the MP4 the last export produced as a single full-length clip. */
async function loadExported() {
  if (!exported) throw new Error('Nothing has been exported yet.')

  const file = new File([exported], 'exported.mp4', { type: 'video/mp4' })
  const store = useTimelineStore.getState()
  store.reset()
  clearSourceFiles()

  const sourceId = 'src-exported'
  registerSourceFile(sourceId, file)
  const geometry = await player.probeSource(sourceId, file)

  store.setComposition({ width: geometry.width, height: geometry.height })
  store.addSource({
    id: sourceId,
    name: 'exported.mp4',
    durationMicros: geometry.durationMicros,
    width: geometry.width,
    height: geometry.height,
    rotation: geometry.rotation,
  })
  store.addClip({
    id: 'clip-exported',
    sourceId,
    sourceInMicros: 0,
    sourceOutMicros: geometry.durationMicros,
    timelineStartMicros: 0,
  })

  const project = useTimelineStore.getState().project
  player.setProject(project)
  throwIfErrored()

  return {
    width: project.composition.width,
    height: project.composition.height,
    durationMicros: timelineDuration(project),
  }
}

/**
 * Strength of one frequency in a block of samples, by the Goertzel algorithm.
 * Cheaper than an FFT and all that is needed here: the fixture tones are pure
 * and the candidates are known in advance.
 */
function goertzel(
  samples: Float32Array,
  sampleRate: number,
  frequency: number,
): number {
  const k = (2 * Math.PI * frequency) / sampleRate
  const coefficient = 2 * Math.cos(k)

  let s1 = 0
  let s2 = 0
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i]! + coefficient * s1 - s2
    s2 = s1
    s1 = s0
  }

  return Math.sqrt(s1 * s1 + s2 * s2 - coefficient * s1 * s2) / samples.length
}

/** Decodes an MP4's audio into one mono track of samples. */
async function decodeAudio(file: File) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  const track = await input.getPrimaryAudioTrack()
  if (!track) return null

  const sampleRate = await track.getSampleRate()
  const sink = new AudioBufferSink(track)
  const chunks: { startSample: number; data: Float32Array }[] = []
  let total = 0

  for await (const wrapped of sink.buffers()) {
    const startSample = Math.round(wrapped.timestamp * sampleRate)
    const data = wrapped.buffer.getChannelData(0).slice()
    chunks.push({ startSample, data })
    total = Math.max(total, startSample + data.length)
  }

  const samples = new Float32Array(total)
  for (const chunk of chunks) samples.set(chunk.data, chunk.startSample)

  input.dispose()
  return { samples, sampleRate }
}

/**
 * Chops decoded audio into windows and reports, for each, the loudest of the
 * candidate tones and how loud the window is overall. A window of silence
 * reports a null tone.
 */
async function audioWindows(options: {
  /** Omit to analyse whatever the last export produced. */
  url?: string
  windowMicros: number
  candidatesHz: number[]
  silenceRms?: number
}) {
  const file = options.url
    ? await fetchAsFile(options.url, 'analysed.mp4')
    : exported
      ? new File([exported], 'exported.mp4', { type: 'video/mp4' })
      : null
  if (!file) throw new Error('Nothing to analyse.')

  const decoded = await decodeAudio(file)
  if (!decoded) return { sampleRate: 0, windows: [] }

  const { samples, sampleRate } = decoded
  const silenceRms = options.silenceRms ?? 0.02
  const windowSamples = Math.round((options.windowMicros / 1e6) * sampleRate)
  const windows: {
    startMicros: number
    rms: number
    silent: boolean
    dominantHz: number | null
  }[] = []

  for (let start = 0; start + windowSamples <= samples.length; start += windowSamples) {
    const block = samples.subarray(start, start + windowSamples)

    let sumSquares = 0
    for (let i = 0; i < block.length; i++) sumSquares += block[i]! * block[i]!
    const rms = Math.sqrt(sumSquares / block.length)

    let dominantHz: number | null = null
    let best = 0
    if (rms >= silenceRms) {
      for (const candidate of options.candidatesHz) {
        const magnitude = goertzel(block, sampleRate, candidate)
        if (magnitude > best) {
          best = magnitude
          dominantHz = candidate
        }
      }
    }

    windows.push({
      startMicros: Math.round((start / sampleRate) * 1e6),
      rms: Number(rms.toFixed(4)),
      silent: rms < silenceRms,
      dominantHz,
    })
  }

  return { sampleRate, windows }
}

/** Renders one timeline position through the preview path, returns pixels. */
async function pixelsAt(timelineMicros: number) {
  const ready = nextTime()
  player.seek(timelineMicros)
  await ready
  throwIfErrored()

  const context = canvas.getContext('2d')
  if (!context) throw new Error('No 2D context on the preview canvas.')

  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  return Array.from(image.data)
}

async function exportMp4() {
  exported = null
  const ready = new Promise<void>((resolve) => {
    notifyExported = resolve
  })
  void player.exportMp4()
  await ready
  throwIfErrored()

  if (!exported) throw new Error('The export produced no buffer.')
  return { byteLength: exported.byteLength }
}

async function playThrough() {
  const stopped = new Promise<void>((resolve) => {
    notifyStopped = resolve
  })

  observedTimes = []
  recordTimes = true
  player.play()
  await stopped
  recordTimes = false
  throwIfErrored()

  return { ...player.stats(), times: observedTimes }
}

Object.assign(window, {
  harness: {
    generateFixture,
    audioWindows,
    loadProject,
    loadExported,
    pixelsAt,
    exportMp4,
    playThrough,
    frameCounts: () => player.frameCounts(),
    setProject: (project: Parameters<typeof player.setProject>[0]) =>
      player.setProject(project),
    duration: () => timelineDuration(useTimelineStore.getState().project),
    microsToSeconds,
  },
})
