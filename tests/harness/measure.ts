/**
 * Measures what a seek actually costs, so pre-roll lead time is chosen from a
 * number rather than a guess.
 *
 * Reports, per clip:
 *  - cold:       fresh Input + sink, time to first frame
 *  - warm:       cached Input, new iterator, time to first frame
 *  - sequential: time to the next frame inside a running iterator (baseline)
 *  - concurrent: two iterators alive on one sink at once
 */
import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacketSink,
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

type Stats = {
  count: number
  min: number
  median: number
  p90: number
  max: number
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!

  return {
    count: sorted.length,
    min: Number(sorted[0]!.toFixed(1)),
    median: Number(at(0.5).toFixed(1)),
    p90: Number(at(0.9).toFixed(1)),
    max: Number(sorted.at(-1)!.toFixed(1)),
  }
}

async function encodeClip(options: {
  frames: number
  width: number
  height: number
  fps: number
  keyFrameInterval?: number
}): Promise<Blob> {
  const { frames, width, height, fps, keyFrameInterval } = options
  const format = new Mp4OutputFormat()
  const codec = await getFirstEncodableVideoCodec(
    format.getSupportedVideoCodecs(),
    { width, height, quality: QUALITY_HIGH },
  )
  if (!codec) throw new Error('No encodable codec.')

  const surface = new OffscreenCanvas(width, height)
  const context = surface.getContext('2d')!
  const output = new Output({ format, target: new BufferTarget() })
  const source = new CanvasSource(surface, {
    codec,
    quality: QUALITY_HIGH,
    keyFrameInterval,
  })
  output.addVideoTrack(source)
  await output.start()

  // A detailed but STATIC background with one small moving element. Changing
  // the whole frame every frame (a full-screen hue shift, scattered noise)
  // reads as a scene change and makes the encoder insert a keyframe every
  // time, which silently defeats keyFrameInterval.
  const backdrop = new OffscreenCanvas(width, height)
  const backdropContext = backdrop.getContext('2d')!
  for (let n = 0; n < 600; n++) {
    backdropContext.fillStyle = `hsl(${(n * 37) % 360} 60% ${30 + (n % 40)}%)`
    backdropContext.fillRect((n * 97) % width, (n * 61) % height, 26, 26)
  }

  for (let index = 0; index < frames; index++) {
    context.drawImage(backdrop, 0, 0)
    context.fillStyle = '#ffffff'
    context.fillRect((index * 4) % (width - 40), height / 2, 40, 40)
    await source.add(index / fps, 1 / fps)
  }

  await output.finalize()
  return new Blob([output.target.buffer!], { type: 'video/mp4' })
}

async function openTrack(blob: Blob): Promise<{
  input: Input
  track: InputVideoTrack
}> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error('No video track.')
  return { input, track }
}

/** Time from asking for a range to holding its first decoded frame. */
async function timeToFirstFrame(
  sink: VideoSampleSink,
  startSeconds: number,
): Promise<number> {
  const started = performance.now()
  const samples = sink.samples(startSeconds)
  const { value } = await samples.next()
  const elapsed = performance.now() - started

  value?.close()
  await samples.return()
  return elapsed
}

/** Timestamps of the key packets, so GOP length is a fact and not an assumption. */
async function keyFrameLayout(track: InputVideoTrack) {
  const packets = new EncodedPacketSink(track)
  const keyTimestamps: number[] = []

  let packet = await packets.getFirstPacket({ metadataOnly: true })
  let total = 0
  while (packet) {
    total++
    if (packet.type === 'key') keyTimestamps.push(Number(packet.timestamp.toFixed(3)))
    packet = await packets.getNextPacket(packet, { metadataOnly: true })
  }

  const gaps = keyTimestamps
    .slice(1)
    .map((value, index) => value - keyTimestamps[index]!)

  return {
    packets: total,
    keyFrames: keyTimestamps.length,
    first8: keyTimestamps.slice(0, 8),
    maxGopSeconds: gaps.length ? Number(Math.max(...gaps).toFixed(3)) : null,
  }
}

async function measureClip(label: string, blob: Blob, durationSeconds: number) {
  const targets = Array.from(
    { length: 20 },
    (_, index) => ((index + 0.5) / 20) * durationSeconds,
  )

  // Cold: a fresh Input each time, i.e. what happens with no cache at all.
  const cold: number[] = []
  for (const target of targets) {
    const { input, track } = await openTrack(blob)
    cold.push(await timeToFirstFrame(new VideoSampleSink(track), target))
    void input
  }

  // Warm: one cached Input and track, a new iterator per seek.
  const { track } = await openTrack(blob)
  const sink = new VideoSampleSink(track)
  await timeToFirstFrame(sink, 0) // prime the codec

  const warmNewSink: number[] = []
  for (const target of targets) {
    warmNewSink.push(await timeToFirstFrame(new VideoSampleSink(track), target))
  }

  const warmSameSink: number[] = []
  for (const target of targets) {
    warmSameSink.push(await timeToFirstFrame(sink, target))
  }

  // Sequential: the cost of the next frame with no seek at all.
  const sequential: number[] = []
  const running = sink.samples(0)
  await running.next()
  for (let index = 0; index < 30; index++) {
    const started = performance.now()
    const { value, done } = await running.next()
    if (done) break
    sequential.push(performance.now() - started)
    value?.close()
  }
  await running.return()

  // Concurrent: two iterators alive on the same sink at the same time.
  let concurrent: string
  try {
    const a = sink.samples(0)
    const b = sink.samples(durationSeconds / 2)
    const [first, second] = await Promise.all([a.next(), b.next()])

    const bothProduced = Boolean(first.value) && Boolean(second.value)
    const distinct =
      first.value && second.value
        ? first.value.timestamp !== second.value.timestamp
        : false

    first.value?.close()
    second.value?.close()
    await Promise.all([a.return(), b.return()])

    concurrent = bothProduced && distinct ? 'ok, both produced distinct frames' : 'produced nothing usable'
  } catch (error) {
    concurrent = `FAILED: ${error instanceof Error ? error.message : String(error)}`
  }

  return {
    label,
    bytes: blob.size,
    keyFrames: await keyFrameLayout(track),
    cold: stats(cold),
    warmNewSink: stats(warmNewSink),
    warmSameSink: stats(warmSameSink),
    sequential: stats(sequential),
    concurrent,
  }
}

async function run() {
  const results = []

  const small = await (await fetch('/tests/fixtures/counter-30fps.mp4')).blob()
  results.push(await measureClip('320x240 6s (committed fixture)', small, 6))

  for (const keyFrameInterval of [2, 10]) {
    const clip = await encodeClip({
      frames: 300,
      width: 1280,
      height: 720,
      fps: 30,
      keyFrameInterval,
    })
    results.push(
      await measureClip(
        `1280x720 10s, ${keyFrameInterval}s keyframe interval`,
        clip,
        10,
      ),
    )
  }

  return results
}

/** Measures real files served by the dev server, rather than generated ones. */
async function runOn(urls: string[]) {
  const results = []

  for (const url of urls) {
    const blob = await (await fetch(url)).blob()
    const { track } = await openTrack(blob)
    const durationSeconds = await track.computeDuration()
    const width = await track.getDisplayWidth()
    const height = await track.getDisplayHeight()

    results.push(
      await measureClip(
        `${url} (${width}x${height}, ${durationSeconds.toFixed(1)}s)`,
        blob,
        durationSeconds,
      ),
    )
  }

  return results
}

Object.assign(window, { measure: { run, runOn } })
