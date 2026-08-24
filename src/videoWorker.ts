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
  soundTracks,
  timelineDuration,
  videoTracks,
  visibleVideoSegmentsAt,
} from './timeline/operations'
import {
  exportDimensions,
  exportSettingsOf,
  isPropertyAnimated,
  propertyAt,
  segmentCovers,
  segmentEndMicros,
  segmentRate,
  soundContent,
  sourceMicrosAt,
  timelineSpanFor,
  transitionWindow,
  videoContent,
  volumeAt,
  type ExportQuality,
  type Project,
  type Segment,
  type Track,
  type VideoContent,
} from './timeline/types'
import {
  AUDIO_BUFFER_MAX_CHUNKS,
  BUFFER_AHEAD_MICROS,
  TRANSCRIBE_SAMPLE_RATE,
  WAVEFORM_BUCKETS_PER_SECOND,
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
  /** Null for a file that carries only sound, which is a normal thing to open. */
  track: InputVideoTrack | null
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
  if (track && !(await track.canDecode())) {
    const codec = await track.getCodecParameterString()
    throw new Error(
      `This browser cannot decode the video codec (${codec ?? 'unknown'}).`,
    )
  }

  const audioTrack = await input.getPrimaryAudioTrack()
  const audioDecodable = audioTrack ? await audioTrack.canDecode() : false

  // A file with neither is not media this editor can use; a file with only
  // sound is music, which is exactly what an audio row is for.
  if (!track && !audioDecodable) {
    throw new Error(
      `${file.name} has no video and no audio this browser can decode.`,
    )
  }

  const opened: OpenSource = {
    input,
    track,
    audioTrack: audioDecodable ? audioTrack : null,
    geometry: {
      durationMicros: secondsToMicros(
        track
          ? await track.computeDuration()
          : await audioTrack!.computeDuration(),
      ),
      hasVideo: track !== null,
      width: track ? await track.getDisplayWidth() : 0,
      height: track ? await track.getDisplayHeight() : 0,
      rotation: track ? await track.getRotation() : 0,
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
    const sourceMicros = sourceMicrosAt(segment, position)

    const opened = await openSource(content.sourceId)
    if (!opened.track) {
      // A segment on a video row pointing at a file with no picture. Nothing
      // to decode, so the row shows a hole for as long as it lasts.
      yield { timelineMicros: position, segmentId: null, frame: null }
      position = segmentEnd
      continue
    }

    const samples = new VideoSampleSink(opened.track).samples(
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
        // start before it. Clamp so timeline timestamps stay monotonic. The
        // source-to-timeline step is where the rate comes in: at double speed
        // a second of footage lands in half a second of timeline.
        const timelineMicros = Math.max(
          position,
          segment.timelineStartMicros +
            timelineSpanFor(segment, decodedMicros - content.sourceInMicros),
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
 * Walks only the TRANSITION WINDOWS of one video row.
 *
 * While a transition runs, its row has two segments on screen at once: the
 * outgoing one, which the ordinary walk above is already producing, and the
 * incoming one blending over it. One iterator cannot yield two streams, so the
 * incoming side gets its own - and because a transition only ever involves a
 * segment and its immediate neighbour, and two transitions are never allowed
 * to overlap, one extra stream per row is always enough.
 *
 * The material is the incoming segment's OWN first frames. Nothing is decoded
 * twice and no footage beyond a segment's range is needed: what used to play
 * just after the cut now plays across it.
 */
async function* walkTransitions(
  current: Project,
  track: Track,
  fromMicros: number,
  myGeneration: number,
): AsyncGenerator<RowFrame> {
  const endMicros = timelineDuration(current)
  let position = Math.max(0, fromMicros)

  const windowOf = (segment: Segment) => transitionWindow(segment)

  while (position < endMicros && myGeneration === generation) {
    const active = track.segments.find((segment) => {
      const window = windowOf(segment)
      return (
        window !== null &&
        position >= window.startMicros &&
        position < window.endMicros
      )
    })

    if (!active) {
      // Between transitions this row contributes no second picture at all.
      const next = track.segments.find((segment) => {
        const window = windowOf(segment)
        return window !== null && window.startMicros > position
      })

      yield { timelineMicros: position, segmentId: null, frame: null }
      position = next ? windowOf(next)!.startMicros : endMicros
      continue
    }

    const window = windowOf(active)!
    const content = videoContent(active)
    const opened = content ? await openSource(content.sourceId) : null

    if (!content || !opened?.track) {
      yield { timelineMicros: position, segmentId: null, frame: null }
      position = window.endMicros
      continue
    }

    const sourceFrom = sourceMicrosAt(active, position)
    const sourceTo = sourceMicrosAt(active, window.endMicros)

    const samples = new VideoSampleSink(opened.track).samples(
      microsToSeconds(sourceFrom),
      microsToSeconds(sourceTo),
    )

    try {
      for await (const sample of samples) {
        if (myGeneration !== generation) {
          sample.close()
          return
        }

        const decodedMicros = Math.round(sample.microsecondTimestamp)
        const frame = takeFrame(sample)
        const timelineMicros = Math.max(
          position,
          active.timelineStartMicros +
            timelineSpanFor(active, decodedMicros - content.sourceInMicros),
        )

        if (timelineMicros >= window.endMicros) {
          frame.close()
          break
        }

        yield { timelineMicros, segmentId: active.id, frame }
      }
    } finally {
      await samples.return()
    }

    // The window is over: clear this stream so the blend stops.
    yield { timelineMicros: window.endMicros, segmentId: null, frame: null }
    position = window.endMicros
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

  // Two streams per row: what it is playing, and what is blending into it.
  const iterators = videoTracks(current).flatMap((track) => [
    walkTrack(current, track, start, myGeneration),
    walkTransitions(current, track, start, myGeneration),
  ])

  /** What each stream is showing now. Owned here, and closed here. */
  const showing: (RowFrame | null)[] = iterators.map(() => null)
  /** The next item each stream has ready, peeked so the merge can order them. */
  const peeked: (RowFrame | null)[] = iterators.map(() => null)

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
 * Every row that makes a sound is walked - audio rows and video rows alike,
 * since a clip carries its own audio and a row hidden behind another is still
 * heard. Rows are walked one at a time so the chunks of a single row arrive
 * contiguously, which is what lets the export join them into long runs instead
 * of scheduling a node per packet.
 */
async function* walkAudio(
  current: Project,
  fromMicros: number,
  myGeneration: number,
): AsyncGenerator<AudioChunk> {
  for (const segment of soundTracks(current).flatMap(
    (track) => track.segments,
  )) {
    if (myGeneration !== generation) return

    const content = soundContent(segment)
    if (!content) continue

    const segmentEnd = segmentEndMicros(segment)
    if (segmentEnd <= fromMicros) continue

    const opened = await openSource(content.sourceId)
    if (!opened.audioTrack) continue

    // Start part way in if playback began mid-segment.
    const startSourceMicros =
      fromMicros > segment.timelineStartMicros
        ? sourceMicrosAt(segment, fromMicros)
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

          const chunkStartMicros =
            segment.timelineStartMicros +
            timelineSpanFor(segment, from - content.sourceInMicros)

          // Speed is applied by LYING about the sample rate: the same samples
          // reported at twice the rate play in half the time, and the audio
          // graph does the resampling on the way in. It shifts pitch, exactly
          // as speeding up a tape does; preserving pitch would need a real
          // time-stretch and is a different feature.
          const playbackRate = rate * segmentRate(segment)

          applyVolume(segment, planes, chunkStartMicros, playbackRate)

          yield {
            timelineMicros: chunkStartMicros,
            sampleRate: playbackRate,
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

/**
 * Scales decoded samples by the segment's volume, in place.
 *
 * Done to the PCM rather than to a gain node in the graph, because live
 * playback schedules buffers and the export renders offline - two mechanisms
 * that would each need their own envelope and could each get it wrong. Scaling
 * the samples once, here, means there is only one answer to how loud something
 * is.
 */
function applyVolume(
  segment: Segment,
  planes: Float32Array<ArrayBuffer>[],
  timelineMicros: number,
  sampleRate: number,
): void {
  if (!isPropertyAnimated(segment, 'volume')) {
    const gain = propertyAt(segment, 'volume', timelineMicros)
    if (gain === 1) return

    for (const plane of planes) {
      for (let i = 0; i < plane.length; i++) plane[i]! *= gain
    }
    return
  }

  // Animated: the gain is read per sample, so a fade is a ramp rather than a
  // staircase at the packet boundaries.
  const frames = planes[0]?.length ?? 0
  for (let i = 0; i < frames; i++) {
    const gain = volumeAt(
      segment,
      timelineMicros + Math.round((i / sampleRate) * 1e6),
    )
    for (const plane of planes) plane[i]! *= gain
  }
}

/**
 * Measures the waveform of a whole source, once.
 *
 * The loudest sample in each bucket rather than an average: an average of a
 * waveform tends to zero, because it is as often below the line as above it.
 * Only the first channel is read - a second one would double the work to draw
 * a shape a few pixels tall that nobody could tell apart.
 */
async function measurePeaks(sourceId: string): Promise<{
  peaks: Float32Array<ArrayBuffer>
  bucketsPerSecond: number
}> {
  const opened = await openSource(sourceId)
  const track = opened.audioTrack
  if (!track) {
    return {
      peaks: new Float32Array(0) as Float32Array<ArrayBuffer>,
      bucketsPerSecond: WAVEFORM_BUCKETS_PER_SECOND,
    }
  }

  const durationMicros = opened.geometry.durationMicros
  const bucketCount = Math.max(
    1,
    Math.ceil((durationMicros / 1e6) * WAVEFORM_BUCKETS_PER_SECOND),
  )
  const peaks = new Float32Array(bucketCount) as Float32Array<ArrayBuffer>

  const samples = new AudioSampleSink(track).samples(0, undefined)
  try {
    for await (const sample of samples) {
      try {
        const frames = sample.numberOfFrames
        if (frames === 0) continue

        const plane = new Float32Array(frames)
        sample.copyTo(plane, { planeIndex: 0, format: 'f32-planar' })

        const rate = sample.sampleRate
        const startMicros = sample.timestamp * 1e6

        for (let i = 0; i < frames; i++) {
          const at = startMicros + (i / rate) * 1e6
          const bucket = Math.floor((at / 1e6) * WAVEFORM_BUCKETS_PER_SECOND)
          if (bucket < 0 || bucket >= bucketCount) continue

          const value = Math.abs(plane[i]!)
          if (value > peaks[bucket]!) peaks[bucket] = value
        }
      } finally {
        sample.close()
      }
    }
  } finally {
    await samples.return()
  }

  return { peaks, bucketsPerSecond: WAVEFORM_BUCKETS_PER_SECOND }
}

/**
 * A source's audio as 16kHz mono, which is what the transcriber wants.
 *
 * The same walk `measurePeaks` does, keeping the samples instead of reducing
 * them to a maximum per bucket. Decoding here rather than outside the browser is
 * what keeps the "no ffmpeg anywhere" rule intact: WebCodecs does the decoding,
 * exactly as it does for the preview and the export, and what leaves is plain
 * PCM.
 *
 * Resampled by nearest neighbour. For speech recognition that is enough - the
 * model band-limits its input anyway - and an interpolating resampler here would
 * be precision nobody can hear spent on a step that exists to save bytes.
 */
async function decodeForTranscription(
  sourceId: string,
): Promise<Float32Array<ArrayBuffer>> {
  const opened = await openSource(sourceId)
  const track = opened.audioTrack
  if (!track) return new Float32Array(0) as Float32Array<ArrayBuffer>

  const seconds = opened.geometry.durationMicros / 1e6
  const out = new Float32Array(
    Math.max(1, Math.ceil(seconds * TRANSCRIBE_SAMPLE_RATE)),
  ) as Float32Array<ArrayBuffer>

  const samples = new AudioSampleSink(track).samples(0, undefined)
  try {
    for await (const sample of samples) {
      try {
        const frames = sample.numberOfFrames
        if (frames === 0) continue

        const channels = sample.numberOfChannels
        const rate = sample.sampleRate
        const startSeconds = sample.timestamp

        // Mixed rather than taking one channel: the words are in both, and
        // half the signal is worth more than the arithmetic costs.
        const mono = new Float32Array(frames)
        const plane = new Float32Array(frames)
        for (let channel = 0; channel < channels; channel++) {
          sample.copyTo(plane, { planeIndex: channel, format: 'f32-planar' })
          for (let i = 0; i < frames; i++) mono[i]! += plane[i]! / channels
        }

        // Walk the OUTPUT indices this sample covers, so every one is written
        // exactly once however the rates relate.
        const from = Math.ceil(startSeconds * TRANSCRIBE_SAMPLE_RATE)
        const to = Math.floor(
          (startSeconds + frames / rate) * TRANSCRIBE_SAMPLE_RATE,
        )
        for (let index = from; index < to && index < out.length; index++) {
          if (index < 0) continue
          const at = Math.round(
            (index / TRANSCRIBE_SAMPLE_RATE - startSeconds) * rate,
          )
          out[index] = mono[Math.min(frames - 1, Math.max(0, at))]!
        }
      } finally {
        sample.close()
      }
    }
  } finally {
    await samples.return()
  }

  return out
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
/** The longest side a sampled frame is scaled to before it is sent anywhere. */
const VISION_FRAME_PX = 512

/** The grid a frame is reduced to for telling shots apart. 8x8 is 64 numbers. */
const SHOT_GRID = 8

/**
 * Takes pictures of a source at intervals.
 *
 * One decode, two products: a small JPEG for a model to look at, and an 8x8 grid
 * of brightnesses for `shots.ts` to compare. Measuring the grid here, while the
 * frame is decoded and already on a canvas, is what lets shot detection be pure
 * arithmetic on numbers rather than something that needs the pictures kept.
 *
 * Every sample and every frame is closed in a `finally`, including on the paths
 * that give up early - `getSample` hands back a VideoSample that owns a frame,
 * `toVideoFrame` makes a second handle, and the leak test counts both.
 */
async function sampleFrames(
  sourceId: string,
  everyMicros: number,
  maxFrames: number,
): Promise<
  { atMicros: number; jpeg: ArrayBuffer; grid: number[] }[]
> {
  const opened = await openSource(sourceId)
  if (!opened.track) return []

  const durationMicros = opened.geometry.durationMicros
  const step = Math.max(1, Math.round(everyMicros))
  const out: { atMicros: number; jpeg: ArrayBuffer; grid: number[] }[] = []

  const sink = new VideoSampleSink(opened.track)

  // Sized from the first frame, since every frame of a source is the same size.
  let canvas: OffscreenCanvas | null = null
  let context: OffscreenCanvasRenderingContext2D | null = null

  for (
    let atMicros = 0;
    atMicros < durationMicros && out.length < maxFrames;
    atMicros += step
  ) {
    const sample = await sink.getSample(microsToSeconds(atMicros))
    if (!sample) continue

    const frame = takeFrame(sample)
    try {
      if (!canvas) {
        const scale = Math.min(
          1,
          VISION_FRAME_PX / Math.max(frame.displayWidth, frame.displayHeight),
        )
        canvas = new OffscreenCanvas(
          Math.max(1, Math.round(frame.displayWidth * scale)),
          Math.max(1, Math.round(frame.displayHeight * scale)),
        )
        context = canvas.getContext('2d')
        if (!context) return out
      }

      context!.drawImage(frame, 0, 0, canvas.width, canvas.height)

      const blob = await canvas.convertToBlob({
        type: 'image/jpeg',
        quality: 0.7,
      })

      out.push({
        atMicros: Math.round(sample.microsecondTimestamp),
        jpeg: await blob.arrayBuffer(),
        grid: gridOf(context!, canvas.width, canvas.height),
      })
    } finally {
      frame.close()
    }
  }

  return out
}

/**
 * A frame reduced to an 8x8 grid of brightnesses.
 *
 * Averaged over each cell rather than sampled at its centre: a single pixel is
 * noise, and two frames of the same static shot would differ by whatever the
 * sensor did that instant.
 */
function gridOf(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): number[] {
  const { data } = context.getImageData(0, 0, width, height)
  const grid: number[] = []

  for (let row = 0; row < SHOT_GRID; row++) {
    for (let column = 0; column < SHOT_GRID; column++) {
      const fromX = Math.floor((column * width) / SHOT_GRID)
      const toX = Math.max(fromX + 1, Math.floor(((column + 1) * width) / SHOT_GRID))
      const fromY = Math.floor((row * height) / SHOT_GRID)
      const toY = Math.max(fromY + 1, Math.floor(((row + 1) * height) / SHOT_GRID))

      let total = 0
      let count = 0
      for (let y = fromY; y < toY; y++) {
        for (let x = fromX; x < toX; x++) {
          const at = (y * width + x) * 4
          // Rec. 601 luma: the eye is far more sensitive to green than to blue,
          // and an unweighted average would call a blue shot and a green one
          // equally bright.
          total +=
            0.299 * data[at]! + 0.587 * data[at + 1]! + 0.114 * data[at + 2]!
          count++
        }
      }
      grid.push(Math.round(total / count))
    }
  }

  return grid
}

async function seek(timelineMicros: number, myGeneration: number) {
  const current = requireProject()
  const wanted = visibleVideoSegmentsAt(current, timelineMicros)

  const layers: { segmentId: string; frame: VideoFrame }[] = []
  const item: RenderItem = { timelineMicros, layers }

  try {
    for (const { segment, sourceMicros } of wanted) {
      const content = segment.content as VideoContent
      const { track } = await openSource(content.sourceId)
      if (!track) continue

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
      // Close the DECODER for anything the project no longer references, which
      // is where the demuxer, the buffers and the open handle live.
      //
      // The FILE is kept, and that distinction matters now there is more than
      // one project: switching to another one sends a project whose sources are
      // all different, and dropping the files here would leave the project
      // being left with nothing to decode from the moment somebody came back to
      // it. A File is a lazy handle rather than the bytes, so keeping it costs
      // almost nothing; the decoder is what was expensive, and that still goes.
      for (const sourceId of [...sources.keys()]) {
        if (!message.project.sources[sourceId]) closeSource(sourceId)
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

    case 'transcribeAudio': {
      const { sourceId, generation: asked } = message
      // Not guarded by the generation, for the same reason a waveform is not:
      // what a file says is a property of the file.
      void decodeForTranscription(sourceId)
        .then((samples) => {
          scope.postMessage(
            {
              type: 'transcribeAudio',
              generation: asked,
              sourceId,
              samples,
              sampleRate: TRANSCRIBE_SAMPLE_RATE,
            },
            [samples.buffer],
          )
        })
        .catch((error) => {
          console.warn('[worker] could not decode audio to transcribe:', error)
          scope.postMessage({
            type: 'transcribeAudio',
            generation: asked,
            sourceId,
            samples: new Float32Array(0),
            sampleRate: TRANSCRIBE_SAMPLE_RATE,
          })
        })
      return
    }

    case 'sampleFrames': {
      const { sourceId, generation: asked, everyMicros, maxFrames } = message
      // Not guarded by the generation, for the same reason the waveform and the
      // transcript are not: what a file LOOKS like is a property of the file.
      void sampleFrames(sourceId, everyMicros, maxFrames)
        .then((frames) => {
          scope.postMessage(
            { type: 'sampleFrames', generation: asked, sourceId, frames },
            frames.map((frame) => frame.jpeg),
          )
        })
        .catch((error: unknown) => {
          scope.postMessage({
            type: 'sampleFrames',
            generation: asked,
            sourceId,
            frames: [],
            error: error instanceof Error ? error.message : String(error),
          })
        })
      return
    }

    case 'peaks': {
      const { sourceId, generation: asked } = message
      // Deliberately not guarded by generation: a waveform is a property of
      // the file, not of what is on the timeline, so it stays true across
      // every edit that happens while it is being measured.
      void measurePeaks(sourceId)
        .then(({ peaks, bucketsPerSecond }) => {
          scope.postMessage(
            {
              type: 'peaks',
              generation: asked,
              sourceId,
              peaks,
              bucketsPerSecond,
            },
            [peaks.buffer],
          )
        })
        .catch((error) => {
          console.warn('[worker] could not measure a waveform:', error)
          scope.postMessage({
            type: 'peaks',
            generation: asked,
            sourceId,
            peaks: new Float32Array(0) as Float32Array<ArrayBuffer>,
            bucketsPerSecond: WAVEFORM_BUCKETS_PER_SECOND,
          })
        })
      return
    }
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
