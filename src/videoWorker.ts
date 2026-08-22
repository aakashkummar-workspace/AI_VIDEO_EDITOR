import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
  getFirstEncodableVideoCodec,
  type InputVideoTrack,
} from 'mediabunny'
import { frameCounts, installFrameTracking } from './frameTracker'
import {
  microsToSeconds,
  renderFrame,
  secondsToMicros,
  takeFrame,
} from './playback'
import { clipAt, timelineDuration } from './timeline/operations'
import { clipEndMicros, type Project } from './timeline/types'
import {
  BUFFER_AHEAD_MICROS,
  BUFFER_MAX_FRAMES,
  type MainToWorker,
  type SourceGeometry,
  type WorkerToMain,
} from './workerProtocol'

// The DOM lib types `self` as a Window; this is the worker surface we use.
const scope = self as unknown as {
  name: string
  postMessage(message: WorkerToMain, transfer?: Transferable[]): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<MainToWorker>) => void,
  ): void
}

if (scope.name === 'instrumented') {
  installFrameTracking('worker')
}

/**
 * One opened source. The Input is held for the project's lifetime because it
 * owns the parsed container index and byte cache, so reopening means reparsing
 * the file. Sinks are NOT cached: measurement showed reusing one saves nothing
 * (16.5ms vs 16.4ms to first frame), since mediabunny builds a fresh decoder
 * per iterator either way.
 */
type OpenSource = {
  input: Input
  track: InputVideoTrack
  geometry: SourceGeometry
}

const sources = new Map<string, OpenSource>()
const files = new Map<string, File>()

/**
 * Drops a source and frees it. An Input holds open decoders and read state, so
 * letting the reference go is not enough - it has to be disposed.
 */
function closeSource(sourceId: string) {
  sources.get(sourceId)?.input.dispose()
  sources.delete(sourceId)
}

let project: Project | null = null

/** Bumped by the UI thread on every play/seek/stop; stale work is abandoned. */
let generation = 0
/** Timeline timestamps posted to the UI thread that it has not consumed. */
let inFlight: number[] = []
let resumePump: (() => void) | null = null

function releasePump() {
  const resume = resumePump
  resumePump = null
  resume?.()
}

/** True while the UI thread has enough decoded ahead of the playhead. */
function bufferIsFull(): boolean {
  if (inFlight.length >= BUFFER_MAX_FRAMES) return true
  if (inFlight.length < 2) return false

  const span = inFlight[inFlight.length - 1]! - inFlight[0]!
  return span >= BUFFER_AHEAD_MICROS
}

async function openSource(sourceId: string): Promise<OpenSource> {
  const existing = sources.get(sourceId)
  if (existing) return existing

  const file = files.get(sourceId)
  if (!file) {
    throw new Error(`No file was provided for source ${sourceId}.`)
  }

  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  })

  const track = await input.getPrimaryVideoTrack()
  if (!track) {
    throw new Error(`Source ${file.name} has no video track.`)
  }
  if (!(await track.canDecode())) {
    const codec = await track.getCodecParameterString()
    throw new Error(
      `This browser cannot decode the video codec (${codec ?? 'unknown'}).`,
    )
  }

  const opened: OpenSource = {
    input,
    track,
    geometry: {
      durationMicros: secondsToMicros(await track.computeDuration()),
      width: await track.getDisplayWidth(),
      height: await track.getDisplayHeight(),
      rotation: await track.getRotation(),
    },
  }

  sources.set(sourceId, opened)
  return opened
}

function requireProject(): Project {
  if (!project) throw new Error('No project has been set.')
  return project
}

export type RenderItem = {
  timelineMicros: number
  frame: VideoFrame | null
}

/**
 * Walks the timeline from `fromMicros` to the end, yielding what should be on
 * screen. Clips yield decoded frames; gaps yield a single null.
 *
 * Crossing a clip boundary just means the current iterator runs out and the
 * next one opens. The seek that costs happens while the UI thread still holds
 * a buffer of frames, so no scheduling is needed here.
 */
async function* walkTimeline(
  current: Project,
  fromMicros: number,
  myGeneration: number,
): AsyncGenerator<RenderItem> {
  const endMicros = timelineDuration(current)
  let position = Math.max(0, fromMicros)

  while (position < endMicros && myGeneration === generation) {
    const found = clipAt(current, position)

    if (!found) {
      // A gap: one black item covering it, then jump to the next clip.
      const next = current.videoTrack.clips.find(
        (clip) => clip.timelineStartMicros > position,
      )
      yield { timelineMicros: position, frame: null }
      position = next ? next.timelineStartMicros : endMicros
      continue
    }

    const { clip } = found
    const clipEnd = clipEndMicros(clip)
    const samples = new VideoSampleSink(
      (await openSource(clip.sourceId)).track,
    ).samples(
      microsToSeconds(found.sourceMicros),
      microsToSeconds(clip.sourceOutMicros),
    )

    try {
      for await (const sample of samples) {
        if (myGeneration !== generation) {
          sample.close()
          return
        }

        const sourceMicros = Math.round(sample.microsecondTimestamp)
        const frame = takeFrame(sample)

        // A sink returns the sample covering the requested time, which can
        // start before it. Clamp so timeline timestamps stay monotonic.
        const timelineMicros = Math.max(
          position,
          clip.timelineStartMicros + (sourceMicros - clip.sourceInMicros),
        )

        if (timelineMicros >= clipEnd) {
          frame.close()
          break
        }

        yield { timelineMicros, frame }
      }
    } finally {
      await samples.return()
    }

    position = clipEnd
  }
}

function postFrame(
  item: RenderItem,
  mode: 'seek' | 'play',
  myGeneration: number,
) {
  const message: WorkerToMain = {
    type: 'frame',
    generation: myGeneration,
    mode,
    timelineMicros: item.timelineMicros,
    frame: item.frame,
  }

  try {
    scope.postMessage(message, item.frame ? [item.frame] : [])
  } catch (err) {
    item.frame?.close()
    throw err
  }
}

/** Decodes the single item at a timeline position, for a paused preview. */
async function seek(timelineMicros: number, myGeneration: number) {
  const current = requireProject()
  const found = clipAt(current, timelineMicros)

  if (!found) {
    postFrame({ timelineMicros, frame: null }, 'seek', myGeneration)
    return
  }

  const { track } = await openSource(found.clip.sourceId)
  const sample = await new VideoSampleSink(track).getSample(
    microsToSeconds(found.sourceMicros),
  )
  if (!sample) {
    postFrame({ timelineMicros, frame: null }, 'seek', myGeneration)
    return
  }

  const frame = takeFrame(sample)
  if (myGeneration !== generation) {
    frame.close()
    return
  }

  postFrame({ timelineMicros, frame }, 'seek', myGeneration)
}

async function play(fromMicros: number, myGeneration: number) {
  const current = requireProject()
  inFlight = []

  for await (const item of walkTimeline(current, fromMicros, myGeneration)) {
    if (myGeneration !== generation) {
      item.frame?.close()
      return
    }

    inFlight.push(item.timelineMicros)
    postFrame(item, 'play', myGeneration)

    if (bufferIsFull()) {
      await new Promise<void>((resolve) => {
        resumePump = resolve
      })
      if (myGeneration !== generation) return
    }
  }

  if (myGeneration === generation) {
    scope.postMessage({ type: 'end', generation: myGeneration })
  }
}

/**
 * Encodes the timeline. Every frame goes through the same renderFrame() the
 * preview uses, including the black of a gap.
 */
async function exportMp4(myGeneration: number) {
  const current = requireProject()
  const { width, height } = current.composition
  const totalMicros = timelineDuration(current)
  if (totalMicros <= 0) {
    throw new Error('There is nothing on the timeline to export.')
  }

  const format = new Mp4OutputFormat()
  const codec = await getFirstEncodableVideoCodec(
    format.getSupportedVideoCodecs(),
    { width, height, quality: QUALITY_HIGH },
  )
  if (!codec) {
    throw new Error(
      'This browser cannot encode any video codec that MP4 supports.',
    )
  }

  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not get a 2D context for the export canvas.')
  }

  const output = new Output({ format, target: new BufferTarget() })
  const source = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH })
  output.addVideoTrack(source)
  await output.start()

  let finalized = false
  let lastReportedPercent = -1
  // Each item is held back until the next one arrives, so its duration is the
  // real gap between them. That keeps the exported file exactly as long as the
  // timeline, gaps included.
  let pending: number | null = null

  async function flush(untilMicros: number) {
    if (pending === null) return
    const duration = untilMicros - pending
    if (duration > 0) {
      await source.add(
        microsToSeconds(pending),
        microsToSeconds(duration),
      )
    }
    pending = null
  }

  try {
    for await (const item of walkTimeline(current, 0, myGeneration)) {
      if (myGeneration !== generation) {
        item.frame?.close()
        return
      }

      await flush(item.timelineMicros)

      try {
        renderFrame(context, current, item.timelineMicros, item.frame)
      } finally {
        item.frame?.close()
      }
      pending = item.timelineMicros

      const percent = Math.floor((item.timelineMicros / totalMicros) * 100)
      if (percent !== lastReportedPercent) {
        lastReportedPercent = percent
        scope.postMessage({
          type: 'exportProgress',
          generation: myGeneration,
          progress: percent / 100,
        })
      }
    }

    if (myGeneration !== generation) return
    await flush(totalMicros)

    await output.finalize()
    finalized = true

    const buffer = output.target.buffer
    if (!buffer) throw new Error('The export produced no data.')

    scope.postMessage({
      type: 'exportProgress',
      generation: myGeneration,
      progress: 1,
    })
    scope.postMessage(
      { type: 'exported', generation: myGeneration, buffer },
      [buffer],
    )
  } finally {
    if (!finalized) {
      // Releases the encoder when the export was abandoned or threw.
      await output.cancel()
    }
  }
}

async function probeSource(sourceId: string, file: File, myGeneration: number) {
  files.set(sourceId, file)
  closeSource(sourceId)

  const { geometry } = await openSource(sourceId)
  scope.postMessage({
    type: 'sourceProbed',
    generation: myGeneration,
    sourceId,
    geometry,
  })
}

scope.addEventListener('message', (event) => {
  const message = event.data
  generation = message.generation

  switch (message.type) {
    case 'probeSource':
      void run(() =>
        probeSource(message.sourceId, message.file, message.generation),
      )
      return

    case 'setProject':
      project = message.project
      // Drop sources the project no longer references.
      for (const sourceId of [...sources.keys()]) {
        if (!message.project.sources[sourceId]) {
          closeSource(sourceId)
          files.delete(sourceId)
        }
      }
      return

    case 'seek':
      releasePump()
      void run(() => seek(message.timelineMicros, message.generation))
      return

    case 'play':
      releasePump()
      void run(() => play(message.fromTimelineMicros, message.generation))
      return

    case 'export':
      releasePump()
      void run(() => exportMp4(message.generation))
      return

    case 'stop':
      inFlight = []
      releasePump()
      return

    case 'consumed':
      inFlight.splice(0, message.count)
      if (!bufferIsFull()) releasePump()
      return

    case 'frameCounts':
      scope.postMessage({
        type: 'frameCounts',
        generation: message.generation,
        counts: frameCounts(),
        openSources: sources.size,
      })
      return
  }
})

async function run(task: () => Promise<void>) {
  const myGeneration = generation

  try {
    await task()
  } catch (err) {
    scope.postMessage({
      type: 'error',
      generation: myGeneration,
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
