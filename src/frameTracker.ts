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
 *   `clone()` counts as a creation too: a clone is a separate handle on the
 *   same picture and has to be closed separately, which is exactly what makes
 *   it a thing that can leak. Stacked rows rely on cloning, so without this the
 *   counts would show more closes than creations and read as a double close.
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

    // A clone of a tracked frame is tracked too, so that handing a row's
    // picture to several composited items stays accounted for. A clone of an
    // untracked frame - one of mediabunny's own - is left alone, for the same
    // reason its close is.
    const originalClone = OriginalVideoFrame.prototype.clone
    OriginalVideoFrame.prototype.clone = function clone(this: VideoFrame) {
      const copy = originalClone.call(this) as VideoFrame
      if (tracked.has(this)) {
        tracked.add(copy)
        counts.created++
      }
      return copy
    }
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
