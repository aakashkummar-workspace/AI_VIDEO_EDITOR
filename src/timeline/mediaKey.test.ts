import { describe, expect, it } from 'vitest'
import { mediaKeyFor } from './mediaKey'

const file = { name: 'IMG_4167.MOV', size: 400_659_955, lastModified: 1_700_000 }

describe('mediaKeyFor', () => {
  it('is the same for the same file imported twice', () => {
    // The whole point: two imports of one file share what was measured from it.
    expect(mediaKeyFor(file)).toBe(mediaKeyFor({ ...file }))
  })

  it('differs when the bytes differ', () => {
    expect(mediaKeyFor(file)).not.toBe(mediaKeyFor({ ...file, size: 1 }))
    expect(mediaKeyFor(file)).not.toBe(
      mediaKeyFor({ ...file, lastModified: 999 }),
    )
    expect(mediaKeyFor(file)).not.toBe(mediaKeyFor({ ...file, name: 'other' }))
  })

  it('survives a file with no modified time', () => {
    // Some browsers and some restored blobs have none. A missing time is not a
    // reason to have no key.
    expect(mediaKeyFor({ name: 'a.mp4', size: 10 })).toBe('10:0:a.mp4')
  })

  it('ignores space around the name', () => {
    expect(mediaKeyFor({ ...file, name: ' IMG_4167.MOV ' })).toBe(
      mediaKeyFor(file),
    )
  })

  it('is a plain string, so it can key a store', () => {
    expect(typeof mediaKeyFor(file)).toBe('string')
    expect(mediaKeyFor(file).length).toBeGreaterThan(0)
  })
})
