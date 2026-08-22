import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'

export type FirstFrameInfo = {
  width: number
  height: number
  /** Presentation timestamp of the drawn frame, in integer microseconds. */
  timestampMicros: number
}

/**
 * Decodes the first video frame of `file` and draws it onto `canvas`,
 * sizing the canvas to the track's real display dimensions.
 */
export async function drawFirstFrame(
  file: Blob,
  canvas: HTMLCanvasElement,
): Promise<FirstFrameInfo> {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  })

  const track = await input.getPrimaryVideoTrack()
  if (!track) {
    throw new Error('This file has no video track.')
  }

  if (!(await track.canDecode())) {
    const codec = await track.getCodecParameterString()
    throw new Error(
      `This browser cannot decode the video codec (${codec ?? 'unknown'}).`,
    )
  }

  const width = await track.getDisplayWidth()
  const height = await track.getDisplayHeight()

  const sink = new VideoSampleSink(track)
  const sample = await sink.getSample(await track.getFirstTimestamp())
  if (!sample) {
    throw new Error('No decodable video frame was found in this file.')
  }

  try {
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Could not get a 2D context from the canvas.')
    }

    canvas.width = width
    canvas.height = height
    sample.draw(context, 0, 0, width, height)

    return {
      width,
      height,
      timestampMicros: Math.round(sample.microsecondTimestamp),
    }
  } finally {
    // Owns the underlying VideoFrame. Not releasing it leaks GPU memory
    // and will eventually crash the tab.
    sample.close()
  }
}
