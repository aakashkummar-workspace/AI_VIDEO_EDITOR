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
  type Rotation,
} from 'mediabunny'
import {
  drawFrame,
  exportProgress,
  microsToSeconds,
  secondsToMicros,
  takeFrame,
} from './playback'
import {
  BUFFER_TARGET,
  type MainToWorker,
  type WorkerToMain,
} from './workerProtocol'

// The DOM lib types `self` as a Window; this is the worker surface we use.
const scope = self as unknown as {
  postMessage(message: WorkerToMain, transfer?: Transferable[]): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<MainToWorker>) => void,
  ): void
}

let track: InputVideoTrack | null = null
let sink: VideoSampleSink | null = null
let geometry: { width: number; height: number; rotation: Rotation } | null =
  null

/** Bumped by the UI thread on every play/seek/stop; stale work is abandoned. */
let generation = 0
/** Frames posted to the UI thread that it has not reported back as consumed. */
let inFlight = 0
let resumePump: (() => void) | null = null

function releasePump() {
  const resume = resumePump
  resumePump = null
  resume?.()
}

async function load(file: File) {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  })

  const videoTrack = await input.getPrimaryVideoTrack()
  if (!videoTrack) {
    throw new Error('This file has no video track.')
  }

  if (!(await videoTrack.canDecode())) {
    const codec = await videoTrack.getCodecParameterString()
    throw new Error(
      `This browser cannot decode the video codec (${codec ?? 'unknown'}).`,
    )
  }

  track = videoTrack
  sink = new VideoSampleSink(videoTrack)
  geometry = {
    width: await videoTrack.getDisplayWidth(),
    height: await videoTrack.getDisplayHeight(),
    rotation: await videoTrack.getRotation(),
  }

  scope.postMessage({
    type: 'loaded',
    generation,
    ...geometry,
    durationMicros: secondsToMicros(await videoTrack.computeDuration()),
  })
}

/** Decodes a single frame for a paused preview. */
async function seek(micros: number, myGeneration: number) {
  if (!sink || !track) {
    throw new Error('No video is loaded.')
  }

  const sample = await sink.getSample(microsToSeconds(micros))
  if (!sample) {
    throw new Error('No decodable video frame was found at that time.')
  }

  const timestampMicros = Math.round(sample.microsecondTimestamp)
  const frame = takeFrame(sample)

  if (myGeneration !== generation) {
    frame.close()
    return
  }

  postFrame(frame, timestampMicros, 'seek', myGeneration)
}

function postFrame(
  frame: VideoFrame,
  timestampMicros: number,
  mode: 'seek' | 'play',
  myGeneration: number,
) {
  try {
    scope.postMessage(
      { type: 'frame', generation: myGeneration, mode, timestampMicros, frame },
      [frame],
    )
  } catch (err) {
    frame.close()
    throw err
  }
}

/**
 * Streams samples sequentially from the sink, staying at most BUFFER_TARGET
 * frames ahead of what the UI thread has drawn.
 */
async function play(fromMicros: number, myGeneration: number) {
  if (!sink) {
    throw new Error('No video is loaded.')
  }

  inFlight = 0
  const samples = sink.samples(microsToSeconds(fromMicros))

  try {
    for await (const sample of samples) {
      if (myGeneration !== generation) {
        sample.close()
        return
      }

      const timestampMicros = Math.round(sample.microsecondTimestamp)
      const frame = takeFrame(sample)

      if (myGeneration !== generation) {
        frame.close()
        return
      }

      inFlight++
      postFrame(frame, timestampMicros, 'play', myGeneration)

      if (inFlight >= BUFFER_TARGET) {
        await new Promise<void>((resolve) => {
          resumePump = resolve
        })

        if (myGeneration !== generation) {
          return
        }
      }
    }

    if (myGeneration === generation) {
      scope.postMessage({ type: 'end', generation: myGeneration })
    }
  } finally {
    // Releases the decoder and closes any samples the sink pre-decoded.
    await samples.return()
  }
}

/**
 * Re-renders every frame through the same drawFrame() the preview uses, into an
 * OffscreenCanvas, and encodes the canvas to MP4 with WebCodecs.
 */
async function exportMp4(myGeneration: number) {
  if (!track || !geometry) {
    throw new Error('No video is loaded.')
  }

  const { width, height, rotation } = geometry
  const format = new Mp4OutputFormat()

  const codec = await getFirstEncodableVideoCodec(format.getSupportedVideoCodecs(), {
    width,
    height,
    quality: QUALITY_HIGH,
  })
  if (!codec) {
    throw new Error('This browser cannot encode any video codec that MP4 supports.')
  }

  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Could not get a 2D context for the export canvas.')
  }

  const durationMicros = secondsToMicros(await track.computeDuration())
  const output = new Output({ format, target: new BufferTarget() })
  const source = new CanvasSource(canvas, { codec, quality: QUALITY_HIGH })
  output.addVideoTrack(source)
  await output.start()

  // A sink of its own, so an interrupted playback iterator cannot interfere.
  const samples = new VideoSampleSink(track).samples()
  let lastReportedPercent = -1
  let finalized = false

  try {
    for await (const sample of samples) {
      if (myGeneration !== generation) {
        sample.close()
        break
      }

      const timestampMicros = Math.round(sample.microsecondTimestamp)
      const sampleDurationMicros = Math.round(sample.microsecondDuration)
      const frame = takeFrame(sample)

      try {
        drawFrame(context, frame, width, height, rotation)
      } finally {
        frame.close()
      }

      // Awaited to respect encoder and writer backpressure.
      await source.add(
        microsToSeconds(timestampMicros),
        sampleDurationMicros > 0
          ? microsToSeconds(sampleDurationMicros)
          : undefined,
      )

      const percent = Math.floor(
        exportProgress(timestampMicros, durationMicros) * 100,
      )
      if (percent !== lastReportedPercent) {
        lastReportedPercent = percent
        scope.postMessage({
          type: 'exportProgress',
          generation: myGeneration,
          progress: percent / 100,
        })
      }
    }

    if (myGeneration !== generation) {
      return
    }

    await output.finalize()
    finalized = true

    const buffer = output.target.buffer
    if (!buffer) {
      throw new Error('The export produced no data.')
    }

    scope.postMessage(
      { type: 'exportProgress', generation: myGeneration, progress: 1 },
    )
    scope.postMessage(
      { type: 'exported', generation: myGeneration, buffer },
      [buffer],
    )
  } finally {
    await samples.return()
    if (!finalized) {
      // Releases the encoder when the export was abandoned or threw.
      await output.cancel()
    }
  }
}

scope.addEventListener('message', (event) => {
  const message = event.data
  generation = message.generation

  switch (message.type) {
    case 'load':
      void run(() => load(message.file))
      return

    case 'seek':
      releasePump()
      void run(() => seek(message.micros, message.generation))
      return

    case 'play':
      releasePump()
      void run(() => play(message.fromMicros, message.generation))
      return

    case 'export':
      releasePump()
      void run(() => exportMp4(message.generation))
      return

    case 'stop':
      inFlight = 0
      releasePump()
      return

    case 'consumed':
      inFlight = Math.max(0, inFlight - message.count)
      if (inFlight < BUFFER_TARGET) {
        releasePump()
      }
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
