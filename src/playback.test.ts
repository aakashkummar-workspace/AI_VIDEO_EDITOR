import { describe, expect, it, vi } from 'vitest'
import {
  drawFrame,
  fitRect,
  exportFileName,
  exportProgress,
  formatMicros,
  microsToSeconds,
  secondsToMicros,
  selectFrame,
  takeFrame,
} from './playback'

function buffered(...timestamps: number[]) {
  return timestamps.map((timelineMicros) => ({ timelineMicros }))
}

/** Records the ops drawFrame issues, so rotation math can be asserted. */
function recordingContext() {
  const ops: string[] = []
  const context = {
    save: () => ops.push('save'),
    restore: () => ops.push('restore'),
    translate: (x: number, y: number) => ops.push(`translate(${x},${y})`),
    rotate: (angle: number) => ops.push(`rotate(${angle.toFixed(4)})`),
    drawImage: (_frame: unknown, x: number, y: number, w: number, h: number) =>
      ops.push(`drawImage(${x},${y},${w},${h})`),
  }
  return { ops, context: context as unknown as CanvasRenderingContext2D }
}

const frame = {} as CanvasImageSource

describe('selectFrame', () => {
  it('draws nothing when the buffer is empty', () => {
    expect(selectFrame([], 1000)).toEqual({ drawIndex: -1, dropCount: 0 })
  })

  it('draws nothing when every frame is still in the future', () => {
    expect(selectFrame(buffered(5000, 6000), 1000)).toEqual({
      drawIndex: -1,
      dropCount: 0,
    })
  })

  it('draws the frame due now without dropping anything', () => {
    expect(selectFrame(buffered(0, 33367, 66733), 33367)).toEqual({
      drawIndex: 1,
      dropCount: 1,
    })
  })

  it('skips to the newest due frame when playback falls behind', () => {
    // Four frames are late; only the newest of them should be drawn.
    expect(selectFrame(buffered(0, 33367, 66733, 100100, 133467), 100100))
      .toEqual({ drawIndex: 3, dropCount: 3 })
  })

  it('holds on the current frame between frame boundaries', () => {
    // A 60Hz tick lands mid-frame on 30fps content: still frame 0, no advance.
    expect(selectFrame(buffered(0, 33367), 16683)).toEqual({
      drawIndex: 0,
      dropCount: 0,
    })
  })
})

describe('takeFrame', () => {
  it('returns the frame and closes the sample', () => {
    const videoFrame = {} as VideoFrame
    const sample = { toVideoFrame: () => videoFrame, close: vi.fn() }

    expect(takeFrame(sample)).toBe(videoFrame)
    expect(sample.close).toHaveBeenCalledTimes(1)
  })

  it('closes the sample even when conversion throws', () => {
    const sample = {
      toVideoFrame: () => {
        throw new Error('conversion failed')
      },
      close: vi.fn(),
    }

    expect(() => takeFrame(sample)).toThrow('conversion failed')
    expect(sample.close).toHaveBeenCalledTimes(1)
  })
})

describe('drawFrame', () => {
  it('draws unrotated video straight to the canvas', () => {
    const { ops, context } = recordingContext()
    drawFrame(context, frame, { x: 0, y: 0, width: 1920, height: 1080 }, 0)

    expect(ops).toEqual([
      'save',
      'translate(0,0)',
      'drawImage(0,0,1920,1080)',
      'restore',
    ])
  })

  it('rotates 90 degrees clockwise into a swapped canvas', () => {
    const { ops, context } = recordingContext()
    drawFrame(context, frame, { x: 0, y: 0, width: 1080, height: 1920 }, 90)

    expect(ops).toEqual([
      'save',
      'translate(0,0)',
      'translate(1080,0)',
      `rotate(${(Math.PI / 2).toFixed(4)})`,
      'drawImage(0,0,1920,1080)',
      'restore',
    ])
  })

  it('rotates 180 degrees', () => {
    const { ops, context } = recordingContext()
    drawFrame(context, frame, { x: 0, y: 0, width: 1920, height: 1080 }, 180)

    expect(ops).toEqual([
      'save',
      'translate(0,0)',
      'translate(1920,1080)',
      `rotate(${Math.PI.toFixed(4)})`,
      'drawImage(0,0,1920,1080)',
      'restore',
    ])
  })

  it('rotates 270 degrees clockwise into a swapped canvas', () => {
    const { ops, context } = recordingContext()
    drawFrame(context, frame, { x: 0, y: 0, width: 1080, height: 1920 }, 270)

    expect(ops).toEqual([
      'save',
      'translate(0,0)',
      'translate(0,1920)',
      `rotate(${(-Math.PI / 2).toFixed(4)})`,
      'drawImage(0,0,1920,1080)',
      'restore',
    ])
  })
})

describe('time units', () => {
  it('converts microseconds to seconds at the sink boundary', () => {
    expect(microsToSeconds(1_500_000)).toBe(1.5)
  })

  it('converts seconds back to integer microseconds', () => {
    expect(secondsToMicros(1.0000004)).toBe(1_000_000)
    expect(Number.isInteger(secondsToMicros(0.033366667))).toBe(true)
  })

  it('formats microseconds for the time display', () => {
    expect(formatMicros(0)).toBe('0:00.00')
    expect(formatMicros(3_450_000)).toBe('0:03.45')
    expect(formatMicros(65_120_000)).toBe('1:05.12')
    expect(formatMicros(-5000)).toBe('0:00.00')
  })
})

describe('one render path', () => {
  it('draws identically for a preview canvas and a worker OffscreenCanvas', () => {
    // The export runs in a worker against an OffscreenCanvas context. If this
    // ever needs a second code path, drawFrame stopped being the only renderer.
    const preview = recordingContext()
    const offscreen = recordingContext()

    drawFrame(preview.context, frame, { x: 0, y: 0, width: 1080, height: 1920 }, 90)
    drawFrame(
      offscreen.context as unknown as OffscreenCanvasRenderingContext2D,
      frame,
      { x: 0, y: 0, width: 1080, height: 1920 },
      90,
    )

    expect(offscreen.ops).toEqual(preview.ops)
  })
})

describe('exportProgress', () => {
  it('reports zero for an unknown duration', () => {
    expect(exportProgress(500_000, 0)).toBe(0)
  })

  it('reports the fraction encoded so far', () => {
    expect(exportProgress(3_000_000, 12_000_000)).toBe(0.25)
  })

  it('clamps to the 0..1 range', () => {
    expect(exportProgress(13_000_000, 12_000_000)).toBe(1)
    expect(exportProgress(-1_000, 12_000_000)).toBe(0)
  })
})

describe('exportFileName', () => {
  it('replaces the source extension', () => {
    expect(exportFileName('clip.mp4')).toBe('clip-export.mp4')
    expect(exportFileName('holiday.MOV')).toBe('holiday-export.mp4')
  })

  it('only strips the final extension', () => {
    expect(exportFileName('scene.1.mov')).toBe('scene.1-export.mp4')
  })

  it('handles names with no extension', () => {
    expect(exportFileName('recording')).toBe('recording-export.mp4')
  })

  it('falls back when there is no usable name', () => {
    expect(exportFileName('')).toBe('export.mp4')
    expect(exportFileName('.mp4')).toBe('export.mp4')
  })
})

describe('fitRect', () => {
  it('fills exactly when the shapes match', () => {
    expect(fitRect(320, 240, 640, 480)).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 480,
    })
  })

  it('letterboxes a wide source into a squarer composition', () => {
    // 16:9 into 4:3 leaves bars above and below.
    expect(fitRect(480, 270, 320, 240)).toEqual({
      x: 0,
      y: 30,
      width: 320,
      height: 180,
    })
  })

  it('pillarboxes a tall source into a wider composition', () => {
    // 4:3 into 16:9 leaves bars to the left and right.
    expect(fitRect(320, 240, 480, 270)).toEqual({
      x: 60,
      y: 0,
      width: 360,
      height: 270,
    })
  })

  it('centres a portrait source in a landscape composition', () => {
    const rect = fitRect(1080, 1920, 1920, 1080)

    expect(rect.height).toBe(1080)
    expect(rect.width).toBe(608)
    // Even margin on both sides.
    expect(rect.x).toBe(Math.round((1920 - rect.width) / 2))
    expect(rect.y).toBe(0)
  })

  it('never distorts: both axes take the same scale', () => {
    // Stated as "within half a pixel of the ideal scaled size" rather than as a
    // ratio. On an extreme source (1000x1) the fitted height rounds 1.28 to 1,
    // which is a 28% ratio error but only a quarter-pixel of real error.
    for (const [sw, sh] of [
      [320, 240],
      [480, 270],
      [1080, 1920],
      [1000, 1],
      [1, 1000],
    ]) {
      const rect = fitRect(sw!, sh!, 1280, 720)
      const scale = Math.min(1280 / sw!, 720 / sh!)

      expect(Math.abs(rect.width - sw! * scale)).toBeLessThanOrEqual(0.5)
      expect(Math.abs(rect.height - sh! * scale)).toBeLessThanOrEqual(0.5)
      expect(rect.width).toBeLessThanOrEqual(1280)
      expect(rect.height).toBeLessThanOrEqual(720)
    }
  })

  it('scales up a source smaller than the composition', () => {
    expect(fitRect(160, 120, 320, 240)).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 240,
    })
  })

  it('is empty for a source with no size', () => {
    expect(fitRect(0, 0, 320, 240)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    })
  })
})

describe('drawFrame placement', () => {
  it('draws into the rect it is given, not the whole canvas', () => {
    const { ops, context } = recordingContext()

    drawFrame(context, frame, { x: 0, y: 30, width: 320, height: 180 }, 0)

    expect(ops).toEqual([
      'save',
      'translate(0,30)',
      'drawImage(0,0,320,180)',
      'restore',
    ])
  })

  it('draws nothing for an empty rect', () => {
    const { ops, context } = recordingContext()

    drawFrame(context, frame, { x: 0, y: 0, width: 0, height: 0 }, 0)

    expect(ops).toEqual([])
  })
})
