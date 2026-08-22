/**
 * Test-only instrumentation for catching VideoFrame leaks.
 *
 * Nothing calls this in normal operation: the worker installs it only when it
 * is started with the name 'instrumented', and the UI thread only when
 * createPlayer is given `instrument: true`.
 *
 * Counting rules differ per thread, because only the worker constructs frames:
 *
 * - Worker: `new VideoFrame(...)` (i.e. VideoSample.toVideoFrame) is counted as
 *   created, and closes are counted only for those frames. Frames the browser
 *   hands to mediabunny's decoder are created natively rather than through the
 *   constructor, so mediabunny closing its own samples is correctly ignored.
 * - UI thread: it never constructs frames, so every close is counted.
 *
 * A clean run therefore satisfies: created === closedInWorker + closedOnMain.
 */

export type FrameCounts = { created: number; closed: number }

const counts: FrameCounts = { created: 0, closed: 0 }
let installed = false

export function installFrameTracking(scope: 'worker' | 'main'): void {
  if (installed) return
  installed = true

  const OriginalVideoFrame = globalThis.VideoFrame
  const tracked = new WeakSet<VideoFrame>()

  if (scope === 'worker') {
    globalThis.VideoFrame = new Proxy(OriginalVideoFrame, {
      construct(target, args: ConstructorParameters<typeof VideoFrame>) {
        const frame = Reflect.construct(target, args) as VideoFrame
        tracked.add(frame)
        counts.created++
        return frame
      },
    })
  }

  const originalClose = OriginalVideoFrame.prototype.close
  OriginalVideoFrame.prototype.close = function close(this: VideoFrame) {
    // On the UI thread every frame came from the worker, so count them all.
    if (scope === 'main' || tracked.has(this)) {
      counts.closed++
    }
    originalClose.call(this)
  }
}

export function frameCounts(): FrameCounts {
  return { ...counts }
}
