/**
 * Wrapping decoded samples in a WAV header.
 *
 * The transcriber is a separate program, and the narrowest thing that can be
 * handed to one is a plain PCM WAV: no container to demux, no codec to decode,
 * nothing that would want ffmpeg on the far side. The audio is already decoded
 * by then - WebCodecs did it, in the worker, exactly as it does for the preview
 * and the export - so this only has to describe it.
 *
 * Sixteen-bit rather than float, which halves the bytes for no audible loss at
 * speech level and is the format every reader supports.
 */

/** 44 bytes: 'RIFF' + fmt + data, with no optional chunks. */
const HEADER_BYTES = 44

function writeAscii(view: DataView, at: number, text: string): void {
  for (let index = 0; index < text.length; index++) {
    view.setUint8(at + index, text.charCodeAt(index))
  }
}

/**
 * One channel of float samples as a 16-bit PCM WAV.
 *
 * Samples outside -1..1 are clamped rather than allowed to wrap: a value that
 * overflowed would come back as the opposite sign, which is heard as a click
 * and read as a consonant.
 */
export function encodeWav16(
  samples: Float32Array,
  sampleRate: number,
): ArrayBuffer {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('A WAV needs a positive sample rate.')
  }

  const buffer = new ArrayBuffer(HEADER_BYTES + samples.length * 2)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(view, 8, 'WAVE')

  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true) // the fmt chunk's own length
  view.setUint16(20, 1, true) // 1 is uncompressed PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // bytes per second
  view.setUint16(32, 2, true) // bytes per frame
  view.setUint16(34, 16, true) // bits per sample

  writeAscii(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)

  for (let index = 0; index < samples.length; index++) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0))
    // Asymmetric on purpose: 16-bit PCM runs -32768..32767, so the two
    // directions do not scale by the same number.
    view.setInt16(
      HEADER_BYTES + index * 2,
      Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767),
      true,
    )
  }

  return buffer
}
