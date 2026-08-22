import { beforeEach, describe, expect, it, vi } from 'vitest'

const track = vi.hoisted(() => ({
  canDecode: vi.fn(),
  getCodecParameterString: vi.fn(),
  getDisplayWidth: vi.fn(),
  getDisplayHeight: vi.fn(),
  getFirstTimestamp: vi.fn(),
}))

const stubs = vi.hoisted(() => ({
  getPrimaryVideoTrack: vi.fn(),
  getSample: vi.fn(),
}))

vi.mock('mediabunny', () => ({
  ALL_FORMATS: [],
  BlobSource: class {},
  Input: class {
    getPrimaryVideoTrack = stubs.getPrimaryVideoTrack
  },
  VideoSampleSink: class {
    getSample = stubs.getSample
  },
}))

const { drawFirstFrame } = await import('./decodeFirstFrame')

function fakeCanvas() {
  const context = {}
  return {
    width: 0,
    height: 0,
    getContext: () => context,
    context,
  } as unknown as HTMLCanvasElement & { context: object }
}

function fakeSample(overrides: Partial<{ draw: () => void }> = {}) {
  return {
    microsecondTimestamp: 33366.6,
    draw: overrides.draw ?? vi.fn(),
    close: vi.fn(),
  }
}

const file = new Blob([]) as Blob

beforeEach(() => {
  vi.clearAllMocks()
  track.canDecode.mockResolvedValue(true)
  track.getCodecParameterString.mockResolvedValue('avc1.640028')
  track.getDisplayWidth.mockResolvedValue(1920)
  track.getDisplayHeight.mockResolvedValue(1080)
  track.getFirstTimestamp.mockResolvedValue(0)
  stubs.getPrimaryVideoTrack.mockResolvedValue(track)
})

describe('drawFirstFrame', () => {
  it('sizes the canvas to the real video dimensions and draws the frame', async () => {
    const sample = fakeSample()
    stubs.getSample.mockResolvedValue(sample)
    const canvas = fakeCanvas()

    const info = await drawFirstFrame(file, canvas)

    expect(canvas.width).toBe(1920)
    expect(canvas.height).toBe(1080)
    expect(sample.draw).toHaveBeenCalledWith(canvas.context, 0, 0, 1920, 1080)
    expect(info).toEqual({ width: 1920, height: 1080, timestampMicros: 33367 })
  })

  it('closes the frame after drawing it', async () => {
    const sample = fakeSample()
    stubs.getSample.mockResolvedValue(sample)

    await drawFirstFrame(file, fakeCanvas())

    expect(sample.close).toHaveBeenCalledTimes(1)
  })

  it('closes the frame even when drawing throws', async () => {
    const sample = fakeSample({
      draw: () => {
        throw new Error('draw exploded')
      },
    })
    stubs.getSample.mockResolvedValue(sample)

    await expect(drawFirstFrame(file, fakeCanvas())).rejects.toThrow(
      'draw exploded',
    )
    expect(sample.close).toHaveBeenCalledTimes(1)
  })

  it('requests the frame at the track first timestamp', async () => {
    track.getFirstTimestamp.mockResolvedValue(0.5)
    stubs.getSample.mockResolvedValue(fakeSample())

    await drawFirstFrame(file, fakeCanvas())

    expect(stubs.getSample).toHaveBeenCalledWith(0.5)
  })

  it('reports a file with no video track', async () => {
    stubs.getPrimaryVideoTrack.mockResolvedValue(null)

    await expect(drawFirstFrame(file, fakeCanvas())).rejects.toThrow(
      'no video track',
    )
  })

  it('reports an undecodable codec by name', async () => {
    track.canDecode.mockResolvedValue(false)

    await expect(drawFirstFrame(file, fakeCanvas())).rejects.toThrow(
      'avc1.640028',
    )
  })

  it('reports when no frame could be decoded', async () => {
    stubs.getSample.mockResolvedValue(null)

    await expect(drawFirstFrame(file, fakeCanvas())).rejects.toThrow(
      'No decodable video frame',
    )
  })
})
