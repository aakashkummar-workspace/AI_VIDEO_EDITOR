import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSampleSink,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type InputAudioTrack,
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
  AUDIO_BUFFER_MAX_CHUNKS,
  BUFFER_AHEAD_MICROS,
  BUFFER_MAX_FRAMES,
  type AudioChunk,
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
  audioTrack: InputAudioTrack | null
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

/** Audio chunks posted but not yet scheduled by the UI thread. */
let audioInFlight = 0
let resumeAudioPump: (() => void) | null = null

function releaseAudioPump() {
  const resume = resumeAudioPump
  resumeAudioPump = null
  resume?.()
}

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

  const audioTrack = await input.getPrimaryAudioTrack()
  const audioDecodable = audioTrack ? await audioTrack.canDecode() : false

  const opened: OpenSource = {
    input,
    track,
    audioTrack: audioDecodable ? audioTrack : null,
    geometry: {
      durationMicros: secondsToMicros(await track.computeDuration()),
      width: await track.getDisplayWidth(),
      height: await track.getDisplayHeight(),
      rotation: await track.getRotation(),
      audio:
        audioDecodable && audioTrack
          ? {
              sampleRate: await audioTrack.getSampleRate(),
              channels: await audioTrack.getNumberOfChannels(),
            }
          : null,
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

/**
 * Walks the timeline yielding decoded PCM, clip by clip.
 *
 * Gaps yield nothing at all: silence is the absence of scheduled audio, not a
 * buffer of zeroes. Chunks are trimmed to the clip's source range frame by
 * frame, so trimming a clip trims its audio exactly rather than to the nearest
 * decoded packet.
 */
async function* walkAudio(
  current: Project,
  fromMicros: number,
  myGeneration: number,
): AsyncGenerator<AudioChunk> {
  for (const clip of current.videoTrack.clips) {
    if (myGeneration !== generation) return

    const clipEnd = clipEndMicros(clip)
    if (clipEnd <= fromMicros) continue

    const opened = await openSource(clip.sourceId)
    if (!opened.audioTrack) continue

    // Start part way in if playback began mid-clip.
    const startSourceMicros =
      fromMicros > clip.timelineStartMicros
        ? clip.sourceInMicros + (fromMicros - clip.timelineStartMicros)
        : clip.sourceInMicros

    const samples = new AudioSampleSink(opened.audioTrack).samples(
      microsToSeconds(startSourceMicros),
      microsToSeconds(clip.sourceOutMicros),
    )

    try {
      for await (const sample of samples) {
        if (myGeneration !== generation) {
          sample.close()
          return
        }

        try {
          const rate = sample.sampleRate
          const sampleStart = Math.round(sample.timestamp * 1e6)
          const sampleEnd =
            sampleStart + Math.round((sample.numberOfFrames / rate) * 1e6)

          // Trim to the clip and to where playback actually starts.
          const from = Math.max(sampleStart, startSourceMicros)
          const to = Math.min(sampleEnd, clip.sourceOutMicros)
          if (to <= from) continue

          const frameOffset = Math.round(((from - sampleStart) / 1e6) * rate)
          const frameCount = Math.min(
            Math.round(((to - from) / 1e6) * rate),
            sample.numberOfFrames - frameOffset,
          )
          if (frameCount <= 0) continue

          const planes: Float32Array<ArrayBuffer>[] = []
          for (let channel = 0; channel < sample.numberOfChannels; channel++) {
            const plane = new Float32Array(frameCount)
            sample.copyTo(plane, {
              planeIndex: channel,
              format: 'f32-planar',
              frameOffset,
              frameCount,
            })
            planes.push(plane)
          }

          yield {
            timelineMicros:
              clip.timelineStartMicros + (from - clip.sourceInMicros),
            sampleRate: rate,
            planes,
          }
        } finally {
          sample.close()
        }
      }
    } finally {
      await samples.return()
    }
  }
}

function postAudioChunk(
  chunk: AudioChunk,
  mode: 'play' | 'export',
  myGeneration: number,
) {
  scope.postMessage(
    { type: 'audioChunk', generation: myGeneration, mode, chunk },
    chunk.planes.map((plane) => plane.buffer as ArrayBuffer),
  )
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

/** Streams the timeline's audio to the UI thread, which schedules it. */
async function streamAudio(
  current: Project,
  fromMicros: number,
  myGeneration: number,
) {
  audioInFlight = 0

  for await (const chunk of walkAudio(current, fromMicros, myGeneration)) {
    if (myGeneration !== generation) return

    audioInFlight++
    postAudioChunk(chunk, 'play', myGeneration)

    if (audioInFlight >= AUDIO_BUFFER_MAX_CHUNKS) {
      await new Promise<void>((resolve) => {
        resumeAudioPump = resolve
      })
      if (myGeneration !== generation) return
    }
  }

  if (myGeneration === generation) {
    scope.postMessage({ type: 'audioEnd', generation: myGeneration, mode: 'play' })
  }
}

async function play(fromMicros: number, myGeneration: number) {
  const current = requireProject()
  inFlight = []

  // Audio runs concurrently: it is the clock, so it must not wait on video.
  void run(() => streamAudio(current, fromMicros, myGeneration))

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
/** Sends the whole timeline's audio for the UI thread to mix offline. */
async function decodeAudioForExport(myGeneration: number) {
  const current = requireProject()

  for await (const chunk of walkAudio(current, 0, myGeneration)) {
    if (myGeneration !== generation) return
    postAudioChunk(chunk, 'export', myGeneration)
  }

  if (myGeneration === generation) {
    scope.postMessage({
      type: 'audioEnd',
      generation: myGeneration,
      mode: 'export',
    })
  }
}

async function exportMp4(
  myGeneration: number,
  audio: { sampleRate: number; planes: Float32Array<ArrayBuffer>[] } | null,
) {
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

  // Every track has to be added before the output starts.
  let audioSource: AudioSampleSource | null = null
  if (audio && audio.planes.length > 0 && audio.planes[0]!.length > 0) {
    const audioCodec = await getFirstEncodableAudioCodec(
      format.getSupportedAudioCodecs(),
      { numberOfChannels: audio.planes.length, sampleRate: audio.sampleRate },
    )
    if (audioCodec) {
      audioSource = new AudioSampleSource({
        codec: audioCodec,
        quality: QUALITY_HIGH,
      })
      output.addAudioTrack(audioSource)
    }
  }

  await output.start()

  if (audioSource && audio) {
    await addMixedAudio(audioSource, audio)
  }

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

/**
 * Feeds the rendered mix in as interleaved chunks. One AudioSample per second
 * keeps each allocation modest on a long timeline.
 */
async function addMixedAudio(
  audioSource: AudioSampleSource,
  audio: { sampleRate: number; planes: Float32Array<ArrayBuffer>[] },
) {
  const channels = audio.planes.length
  const total = audio.planes[0]!.length
  const chunkFrames = audio.sampleRate

  for (let offset = 0; offset < total; offset += chunkFrames) {
    const frames = Math.min(chunkFrames, total - offset)
    const interleaved = new Float32Array(frames * channels)

    for (let channel = 0; channel < channels; channel++) {
      const plane = audio.planes[channel]!
      for (let frame = 0; frame < frames; frame++) {
        interleaved[frame * channels + channel] = plane[offset + frame]!
      }
    }

    const sample = new AudioSample({
      data: interleaved,
      format: 'f32',
      numberOfChannels: channels,
      sampleRate: audio.sampleRate,
      timestamp: offset / audio.sampleRate,
    })

    try {
      await audioSource.add(sample)
    } finally {
      sample.close()
    }
  }

  audioSource.close()
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
      releaseAudioPump()
      void run(() => seek(message.timelineMicros, message.generation))
      return

    case 'play':
      releasePump()
      releaseAudioPump()
      void run(() => play(message.fromTimelineMicros, message.generation))
      return

    case 'export':
      releasePump()
      releaseAudioPump()
      void run(() => exportMp4(message.generation, message.audio))
      return

    case 'decodeAudioForExport':
      void run(() => decodeAudioForExport(message.generation))
      return

    case 'audioConsumed':
      audioInFlight = Math.max(0, audioInFlight - message.count)
      if (audioInFlight < AUDIO_BUFFER_MAX_CHUNKS) releaseAudioPump()
      return

    case 'stop':
      inFlight = []
      audioInFlight = 0
      releasePump()
      releaseAudioPump()
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
