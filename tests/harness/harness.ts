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

const canvas = document.getElementById('canvas') as HTMLCanvasElement

let loaded: { width: number; height: number; durationMicros: number } | null =
  null
let lastError: string | null = null
let exported: ArrayBuffer | null = null

let notifyTime: (() => void) | null = null
let notifyStopped: (() => void) | null = null
let notifyExported: (() => void) | null = null

const player = createPlayer(
  canvas,
  {
    onLoaded: (info) => {
      loaded = info
    },
    onTime: () => {
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
}) {
  const { frames, width, height, fps } = options
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
    context.fillStyle = `hsl(${(index * 7) % 360} 70% 45%)`
    context.fillRect(0, 0, width, height)

    context.fillStyle = '#ffffff'
    context.fillRect((index * 3) % width, 0, 24, height)

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

async function loadFile(file: File) {
  loaded = null
  lastError = null

  const ready = nextTime()
  player.load(file)
  await ready
  throwIfErrored()

  return loaded
}

/** Loads the fixture straight from the dev server, no data round trip. */
async function load(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not fetch ${url}.`)

  const bytes = await response.arrayBuffer()
  return loadFile(new File([bytes], 'fixture.mp4', { type: 'video/mp4' }))
}

/** Loads the MP4 that the last export produced, so it can be compared. */
async function loadExported() {
  if (!exported) throw new Error('Nothing has been exported yet.')
  return loadFile(new File([exported], 'exported.mp4', { type: 'video/mp4' }))
}

/** Renders one frame through the preview path and returns the canvas pixels. */
async function pixelsAt(micros: number) {
  const ready = nextTime()
  player.seek(micros)
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
  player.play()
  await stopped
  throwIfErrored()

  return player.stats()
}

Object.assign(window, {
  harness: {
    generateFixture,
    load,
    loadExported,
    pixelsAt,
    exportMp4,
    playThrough,
    frameCounts: () => player.frameCounts(),
    duration: () => loaded?.durationMicros ?? 0,
    microsToSeconds,
  },
})
