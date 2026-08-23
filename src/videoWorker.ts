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
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
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
  type DecodedLayers,
} from './playback'
import {
  timelineDuration,
  videoTracks,
  visibleVideoSegmentsAt,
} from './timeline/operations'
import {
  exportDimensions,
  exportSettingsOf,
  segmentCovers,
  segmentEndMicros,
  videoContent,
  type ExportQuality,
  type Project,
  type Track,
  type VideoContent,
} from './timeline/types'
import {
  AUDIO_BUFFER_MAX_CHUNKS,
  BUFFER_AHEAD_MICROS,
  BUFFER_MAX_FRAMES,
  BUFFER_MAX_ITEMS,
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
/**
 * Render items posted to the UI thread that it has not consumed, and how many
 * decoded frames each one is carrying.
 *
 * The frame count is not the item count: one item holds one frame per video
 * row that has to be drawn, so a stack of rows puts several frames in flight
 * per item. Counting items alone would let the real memory in flight grow with
 * the number of rows while the cap looked unchanged.
 */
let inFlight: { timelineMicros: number; frames: number }[] = []
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

/** Decoded frames the UI thread is holding, across every row. */
function inFlightFrames(): number {
  let total = 0
  for (const item of inFlight) total += item.frames
  return total
}

/**
 * True while the UI thread has enough decoded ahead of the playhead.
 *
 * Three bounds, and the tightest wins: the frames in flight, the items in
 * flight, and how far ahead of the playhead they reach. The item bound matters
 * on its own because a run of gaps carries no frames at all and would
 * otherwise never fill the buffer.
 */
function bufferIsFull(): boolean {
  if (inFlightFrames() >= BUFFER_MAX_FRAMES) return true
  if (inFlight.length >= BUFFER_MAX_ITEMS) return true
  if (inFlight.length < 2) return false

  const span =
    inFlight[inFlight.length - 1]!.timelineMicros - inFlight[0]!.timelineMicros
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

/** What one video row is showing at a moment: a segment, or nothing. */
type RowFrame = {
  timelineMicros: number
  segmentId: string | null
  frame: VideoFrame | null
}

/**
 * Everything that should be on screen at one moment: one entry per video row
 * that has a picture. Rows are stacked by the renderer, not here.
 */
export type RenderItem = {
  timelineMicros: number
  layers: { segmentId: string; frame: VideoFrame }[]
}

/** Frees every frame an item is carrying. */
function closeItem(item: RenderItem): void {
  for (const layer of item.layers) layer.frame.close()
}

/**
 * Walks ONE video row, yielding its decoded frames and a null wherever it has
 * nothing.
 *
 * A row is walked on its own because that is what it is: an independent strip
 * of footage. What ends up visible is decided later, by stacking the rows.
 */
async function* walkTrack(
  current: Project,
  track: Track,
  fromMicros: number,
  myGeneration: number,
): AsyncGenerator<RowFrame> {
  const endMicros = timelineDuration(current)
  let position = Math.max(0, fromMicros)

  while (position < endMicros && myGeneration === generation) {
    const segment = track.segments.find((candidate) =>
      segmentCovers(candidate, position),
    )

    if (!segment) {
      // Nothing on this row here: report the hole, then skip to whatever it
      // shows next. Another row may well be filling the picture meanwhile.
      const next = track.segments.find(
        (candidate) => candidate.timelineStartMicros > position,
      )
      yield { timelineMicros: position, segmentId: null, frame: null }
      position = next ? next.timelineStartMicros : endMicros
      continue
    }

    const content = videoContent(segment)
    if (!content) {
      position = segmentEndMicros(segment)
      continue
    }

    const segmentEnd = segmentEndMicros(segment)
    const sourceMicros =
      content.sourceInMicros + (position - segment.timelineStartMicros)

    const samples = new VideoSampleSink(
      (await openSource(content.sourceId)).track,
    ).samples(
      microsToSeconds(sourceMicros),
      microsToSeconds(content.sourceOutMicros),
    )

    try {
      for await (const sample of samples) {
        if (myGeneration !== generation) {
          sample.close()
          return
        }

        const decodedMicros = Math.round(sample.microsecondTimestamp)
        const frame = takeFrame(sample)

        // A sink returns the sample covering the requested time, which can
        // start before it. Clamp so timeline timestamps stay monotonic.
        const timelineMicros = Math.max(
          position,
          segment.timelineStartMicros +
            (decodedMicros - content.sourceInMicros),
        )

        if (timelineMicros >= segmentEnd) {
          frame.close()
          break
        }

        yield { timelineMicros, segmentId: segment.id, frame }
      }
    } finally {
      await samples.return()
    }

    position = segmentEnd
  }
}

/**
 * The moments at which the picture can change without any video row producing
 * a frame: a caption appearing or disappearing.
 *
 * Without these an export would hold one rendered frame across a whole gap,
 * and a caption that started inside that gap would never appear in the file
 * even though the preview shows it.
 */
function textEdgeTimes(
  current: Project,
  fromMicros: number,
  endMicros: number,
): number[] {
  const edges = new Set<number>()

  for (const track of current.tracks) {
    if (track.kind !== 'text') continue
    for (const segment of track.segments) {
      for (const edge of [
        segment.timelineStartMicros,
        segmentEndMicros(segment),
      ]) {
        if (edge > fromMicros && edge < endMicros) edges.add(edge)
      }
    }
  }

  return [...edges].sort((a, b) => a - b)
}

/**
 * Walks the timeline from `fromMicros` to the end, yielding what should be on
 * screen at each moment it changes.
 *
 * Every video row is walked independently and the results are merged: an item
 * comes out whenever ANY row produces a new frame, carrying the current
 * picture from all of them. A row that has not moved keeps showing what it
 * showed, which is why each item gets its own CLONE of that frame rather than
 * a shared reference - an item is closed once it has been drawn, and the row
 * still needs its original for the next one.
 *
 * Which of the merged rows actually gets painted is renderFrame's business,
 * not this walk's. Deciding it twice is how a preview and an export drift
 * apart, so it is decided once, there.
 */
async function* walkTimeline(
  current: Project,
  fromMicros: number,
  myGeneration: number,
): AsyncGenerator<RenderItem> {
  const endMicros = timelineDuration(current)
  const start = Math.max(0, fromMicros)
  if (start >= endMicros) return

  const tracks = videoTracks(current)
  const iterators = tracks.map((track) =>
    walkTrack(current, track, start, myGeneration),
  )

  /** What each row is showing now. Owned here, and closed here. */
  const showing: (RowFrame | null)[] = tracks.map(() => null)
  /** The next item each row has ready, peeked so the merge can order them. */
  const peeked: (RowFrame | null)[] = tracks.map(() => null)

  const edges = textEdgeTimes(current, start, endMicros)
  let edgeIndex = 0
  /** Set once the first item has been emitted, so `start` is always covered. */
  let emitted = false

  function release(row: RowFrame | null) {
    row?.frame?.close()
  }

  try {
    for (let i = 0; i < iterators.length; i++) {
      peeked[i] = (await iterators[i]!.next()).value ?? null
    }

    while (myGeneration === generation) {
      let at: number | null = emitted ? null : start

      for (const row of peeked) {
        if (row && (at === null || row.timelineMicros < at)) {
          at = row.timelineMicros
        }
      }

      const edge = edgeIndex < edges.length ? edges[edgeIndex]! : null
      if (edge !== null && (at === null || edge < at)) at = edge

      if (at === null) break

      for (let i = 0; i < iterators.length; i++) {
        while (peeked[i] && peeked[i]!.timelineMicros <= at) {
          release(showing[i])
          showing[i] = peeked[i]
          peeked[i] = (await iterators[i]!.next()).value ?? null
          if (myGeneration !== generation) return
        }
      }

      if (edge !== null && edge <= at) edgeIndex++

      const layers: { segmentId: string; frame: VideoFrame }[] = []
      for (const row of showing) {
        if (!row?.frame || !row.segmentId) continue
        // Clone: this item owns what it carries, and the row keeps its own.
        layers.push({ segmentId: row.segmentId, frame: row.frame.clone() })
      }

      emitted = true
      const item: RenderItem = { timelineMicros: at, layers }
      try {
        yield item
      } catch (err) {
        closeItem(item)
        throw err
      }
    }
  } finally {
    for (const row of showing) release(row)
    for (const row of peeked) release(row)
    for (const iterator of iterators) await iterator.return(undefined)
  }
}

/** The layers of an item, in the shape renderFrame reads them. */
function layersOf(item: RenderItem): DecodedLayers {
  return new Map(item.layers.map((layer) => [layer.segmentId, layer.frame]))
}

/**
 * Walks the timeline yielding decoded PCM, segment by segment.
 *
 * Gaps yield nothing at all: silence is the absence of scheduled audio, not a
 * buffer of zeroes. Chunks are trimmed to the source range frame by frame, so
 * trimming a segment trims its audio exactly rather than to the nearest
 * decoded packet.
 *
 * Every video row is walked, not just the topmost one: a row hidden behind
 * another is still heard. Rows are walked one at a time so the chunks of a
 * single row arrive contiguously, which is what lets the export join them into
 * long runs instead of scheduling a node per packet.
 */
async function* walkAudio(
  current: Project,
  fromMicros: number,
  myGeneration: number,
): AsyncGenerator<AudioChunk> {
  for (const segment of videoTracks(current).flatMap(
    (track) => track.segments,
  )) {
    if (myGeneration !== generation) return

    const content = videoContent(segment)
    if (!content) continue

    const segmentEnd = segmentEndMicros(segment)
    if (segmentEnd <= fromMicros) continue

    const opened = await openSource(content.sourceId)
    if (!opened.audioTrack) continue

    // Start part way in if playback began mid-segment.
    const startSourceMicros =
      fromMicros > segment.timelineStartMicros
        ? content.sourceInMicros + (fromMicros - segment.timelineStartMicros)
        : content.sourceInMicros

    const samples = new AudioSampleSink(opened.audioTrack).samples(
      microsToSeconds(startSourceMicros),
      microsToSeconds(content.sourceOutMicros),
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

          // Trim to the segment and to where playback actually starts.
          const from = Math.max(sampleStart, startSourceMicros)
          const to = Math.min(sampleEnd, content.sourceOutMicros)
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
              segment.timelineStartMicros + (from - content.sourceInMicros),
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
    layers: item.layers,
  }

  try {
    scope.postMessage(
      message,
      item.layers.map((layer) => layer.frame),
    )
  } catch (err) {
    closeItem(item)
    throw err
  }
}

/**
 * Decodes the single item at a timeline position, for a paused preview.
 *
 * Every row that has to be drawn is decoded, not just the top one: a scaled or
 * faded segment lets what is under it show through, and a paused preview has
 * to show the same picture playback would.
 */
async function seek(timelineMicros: number, myGeneration: number) {
  const current = requireProject()
  const wanted = visibleVideoSegmentsAt(current, timelineMicros)

  const layers: { segmentId: string; frame: VideoFrame }[] = []
  const item: RenderItem = { timelineMicros, layers }

  try {
    for (const { segment, sourceMicros } of wanted) {
      const content = segment.content as VideoContent
      const { track } = await openSource(content.sourceId)
      const sample = await new VideoSampleSink(track).getSample(
        microsToSeconds(sourceMicros),
      )
      if (!sample) continue

      layers.push({ segmentId: segment.id, frame: takeFrame(sample) })
    }
  } catch (err) {
    closeItem(item)
    throw err
  }

  if (myGeneration !== generation) {
    closeItem(item)
    return
  }

  postFrame(item, 'seek', myGeneration)
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
      closeItem(item)
      return
    }

    inFlight.push({
      timelineMicros: item.timelineMicros,
      frames: item.layers.length,
    })
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

/** The encoder preset behind each name the project can choose. */
const QUALITY_FOR: Record<ExportQuality, typeof QUALITY_HIGH> = {
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  'very-high': QUALITY_VERY_HIGH,
}

async function exportMp4(
  myGeneration: number,
  audio: { sampleRate: number; planes: Float32Array<ArrayBuffer>[] } | null,
) {
  const current = requireProject()
  const settings = exportSettingsOf(current)
  const { width, height } = exportDimensions(current.composition, settings)
  const quality = QUALITY_FOR[settings.quality]

  const totalMicros = timelineDuration(current)
  if (totalMicros <= 0) {
    throw new Error('There is nothing on the timeline to export.')
  }

  const format = new Mp4OutputFormat()
  const codec = await getFirstEncodableVideoCodec(
    format.getSupportedVideoCodecs(),
    { width, height, quality },
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

  // The render function draws in COMPOSITION coordinates and knows nothing
  // about the file being written. Scaling the context once here is what lets
  // the same function fill an export canvas of a different size - so exporting
  // at another resolution cannot draw anything differently, only larger or
  // smaller. Filter radii scale with it, which is what you want: a blur is a
  // fraction of the picture, not a number of output pixels.
  context.scale(
    width / current.composition.width,
    height / current.composition.height,
  )

  const output = new Output({ format, target: new BufferTarget() })
  const source = new CanvasSource(canvas, { codec, quality })
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
        closeItem(item)
        return
      }

      await flush(item.timelineMicros)

      try {
        renderFrame(context, current, item.timelineMicros, layersOf(item))
      } finally {
        closeItem(item)
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
