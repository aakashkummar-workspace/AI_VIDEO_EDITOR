import { describe, expect, it } from 'vitest'
import { encodeWav16 } from './wav'

/** Reads back a 4-character chunk id, which is how a WAV is identified at all. */
function ascii(view: DataView, at: number, length: number): string {
  let out = ''
  for (let index = 0; index < length; index++) {
    out += String.fromCharCode(view.getUint8(at + index))
  }
  return out
}

describe('encodeWav16', () => {
  it('writes a header a reader can identify', () => {
    const view = new DataView(encodeWav16(new Float32Array(4), 16_000))

    expect(ascii(view, 0, 4)).toBe('RIFF')
    expect(ascii(view, 8, 4)).toBe('WAVE')
    expect(ascii(view, 12, 4)).toBe('fmt ')
    expect(ascii(view, 36, 4)).toBe('data')
  })

  it('describes mono 16-bit PCM at the rate it was given', () => {
    const view = new DataView(encodeWav16(new Float32Array(8), 16_000))

    expect(view.getUint16(20, true)).toBe(1) // uncompressed
    expect(view.getUint16(22, true)).toBe(1) // one channel
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(34, true)).toBe(16) // bits per sample
    expect(view.getUint16(32, true)).toBe(2) // bytes per frame
    expect(view.getUint32(28, true)).toBe(32_000) // bytes per second
  })

  it('sizes both length fields to the samples it carries', () => {
    // Getting either wrong makes a file that opens and then plays the wrong
    // amount of audio, which is worse than one that will not open.
    const view = new DataView(encodeWav16(new Float32Array(100), 16_000))

    expect(view.getUint32(40, true)).toBe(200) // the data chunk
    expect(view.getUint32(4, true)).toBe(236) // everything after 'RIFF'
    expect(view.buffer.byteLength).toBe(244)
  })

  it('scales full-scale samples to the ends of the range', () => {
    const view = new DataView(
      encodeWav16(new Float32Array([0, 1, -1, 0.5]), 16_000),
    )

    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(32_767)
    expect(view.getInt16(48, true)).toBe(-32_768)
    expect(view.getInt16(50, true)).toBe(16_384)
  })

  it('clamps rather than letting a loud sample wrap', () => {
    // A value that overflowed would come back the opposite sign, which is heard
    // as a click and read as a consonant.
    const view = new DataView(encodeWav16(new Float32Array([4, -4]), 16_000))

    expect(view.getInt16(44, true)).toBe(32_767)
    expect(view.getInt16(46, true)).toBe(-32_768)
  })

  it('writes a header and nothing else for silence of no length', () => {
    expect(encodeWav16(new Float32Array(0), 16_000).byteLength).toBe(44)
  })

  it('refuses a rate that cannot describe anything', () => {
    expect(() => encodeWav16(new Float32Array(4), 0)).toThrow(/positive/)
    expect(() => encodeWav16(new Float32Array(4), -1)).toThrow(/positive/)
  })
})
