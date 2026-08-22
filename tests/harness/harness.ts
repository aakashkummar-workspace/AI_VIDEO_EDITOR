/**
 * Browser-side driver for the Playwright tests. It exercises the real player
 * and the real worker; it does not reimplement any of the rendering.
 */
import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
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
  await output.start()

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
  player.exportMp4()
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
    loadProject,
    loadExported,
    pixelsAt,
    exportMp4,
    playThrough,
    frameCounts: () => player.frameCounts(),
    duration: () => timelineDuration(useTimelineStore.getState().project),
    microsToSeconds,
  },
})
