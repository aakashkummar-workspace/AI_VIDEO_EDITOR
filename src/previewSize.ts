/**
 * How big the preview surface is.
 *
 * The composition is what the project is AUTHORED at, and on a phone recording
 * that is now routinely 2160x3840 - eight and a half megapixels, sixty times a
 * second, composited into a canvas a few hundred pixels wide on screen. Almost
 * all of that work is thrown away by the browser scaling it down to fit.
 *
 * So the preview draws onto a smaller surface and scales its context ONCE,
 * which is exactly what the export already does for a different output size.
 * `renderFrame` is untouched and never learns the surface size: a different
 * preview resolution can only make the same picture smaller, never a second
 * render path. The EXPORT is unaffected and still writes at full size, which is
 * what keeps the golden-frame comparison meaningful.
 *
 * The cap is generous on purpose. It is not a quality setting: 1080p and
 * everything under it - which is every committed fixture, and most footage - is
 * untouched and drawn at its own size. It bites only above that, where the
 * pixels could not reach a screen anyway. Portrait 4K, the case this was found
 * on, halves to 1080x1920 and does a quarter of the work.
 */

export const PREVIEW_MAX_PX = 1920

export type Size = { width: number; height: number }

/** How much the preview is drawn down by, or 1 when it is not. */
export function previewScaleFor(composition: Size): number {
  const longest = Math.max(composition.width, composition.height)
  if (longest <= PREVIEW_MAX_PX || longest <= 0) return 1
  return PREVIEW_MAX_PX / longest
}

/**
 * The canvas size for a composition.
 *
 * Rounded UP, so the surface is never a fraction of a pixel short of what the
 * scaled context draws into - a canvas one pixel small leaves a seam down the
 * edge of the picture.
 */
export function previewSizeFor(composition: Size): Size {
  const scale = previewScaleFor(composition)
  if (scale === 1) {
    return { width: composition.width, height: composition.height }
  }

  return {
    width: Math.max(1, Math.ceil(composition.width * scale)),
    height: Math.max(1, Math.ceil(composition.height * scale)),
  }
}
