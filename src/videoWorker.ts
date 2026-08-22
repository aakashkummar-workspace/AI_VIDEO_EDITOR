import {
  ALL_FORMATS,
  BlobSource,
  Input,
  VideoSampleSink,
  type InputVideoTrack,
} from 'mediabunny'
import { microsToSeconds, secondsToMicros, takeFrame } from './playback'
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

  scope.postMessage({
    type: 'loaded',
    generation,
    width: await videoTrack.getDisplayWidth(),
    height: await videoTrack.getDisplayHeight(),
    rotation: await videoTrack.getRotation(),
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
