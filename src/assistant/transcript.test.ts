import { describe, expect, it } from 'vitest'
import { dropRunawayRepeats, type Transcript } from './transcript'
import {
  LANGUAGE_STORAGE_KEY,
  MIXED,
  SPOKEN_LANGUAGES,
  readSpokenLanguage,
  writeSpokenLanguage,
} from './language'

function transcript(
  lines: { start: number; end: number; text: string }[],
): Transcript {
  return {
    language: 'ta',
    duration: 30,
    text: lines.map((line) => line.text).join(' '),
    segments: lines.map((line, index) => ({
      ...line,
      words: [
        {
          start: line.start,
          end: line.end,
          word: `w${index}`,
          probability: 0.9,
        },
      ],
    })),
  }
}

describe('dropRunawayRepeats', () => {
  it('leaves real speech exactly as it found it', () => {
    // The guard has to be invisible on a good transcript, or every cut made
    // against one is made against something the transcriber did not say.
    const good = transcript([
      { start: 0, end: 2, text: 'this is our website' },
      { start: 2, end: 4, text: 'and this is the one we use' },
      { start: 4, end: 6, text: 'and here is another' },
    ])

    expect(dropRunawayRepeats(good)).toEqual(good)
  })

  it('collapses one word said over and over into one of it', () => {
    // The failure this exists for: a phrase repeated a few hundred times, which
    // is what Whisper emits when it gets stuck.
    const stuck = ['this is our website', ...Array(80).fill('booking')].join(' ')

    const out = dropRunawayRepeats(
      transcript([{ start: 0, end: 30, text: stuck }]),
    )

    expect(out.segments[0]!.text).toBe('this is our website booking')
  })

  it('collapses a repeated PHRASE, not just a repeated word', () => {
    const out = dropRunawayRepeats(
      transcript([
        {
          start: 0,
          end: 30,
          text: 'hello there ' + 'come and see come and see come and see come and see',
        },
      ]),
    )

    expect(out.segments[0]!.text).toBe('hello there come and see')
  })

  it('takes the shortest loop, not a longer one that happens to fit', () => {
    // "a a a a a a" is one word six times, not a three-word phrase twice.
    const out = dropRunawayRepeats(
      transcript([{ start: 0, end: 9, text: 'go go go go go go' }]),
    )

    expect(out.segments[0]!.text).toBe('go')
  })

  it('keeps a phrase said twice, which is emphasis rather than a fault', () => {
    const said = transcript([{ start: 0, end: 3, text: 'no no it is fine' }])

    expect(dropRunawayRepeats(said).segments[0]!.text).toBe('no no it is fine')
  })

  it('drops the later windows of a loop that spans several of them', () => {
    // A 30-second window is decoded on its own, so a loop long enough to fill
    // more than one comes back as consecutive segments saying the same thing.
    // Only the first of them was ever spoken.
    const out = dropRunawayRepeats(
      transcript([
        { start: 0, end: 3, text: 'this is our website' },
        { start: 3, end: 6, text: 'booking booking booking booking' },
        { start: 6, end: 9, text: 'booking booking booking booking' },
        { start: 9, end: 12, text: 'booking booking booking booking' },
        { start: 12, end: 15, text: 'thanks for watching' },
      ]),
    )

    expect(out.segments.map((segment) => segment.text)).toEqual([
      'this is our website',
      'booking',
      'thanks for watching',
    ])
  })

  it('reads the window a loop started in and the ones after it as one loop', () => {
    // The first window has real speech in front of the loop, so its collapsed
    // text is not equal to the windows that follow - it ENDS with them.
    const out = dropRunawayRepeats(
      transcript([
        {
          start: 0,
          end: 3,
          text: ['this is our website', ...Array(20).fill('booking')].join(' '),
        },
        { start: 3, end: 6, text: 'booking booking booking booking' },
        { start: 6, end: 9, text: 'booking booking booking booking' },
      ]),
    )

    expect(out.segments.map((segment) => segment.text)).toEqual([
      'this is our website booking',
    ])
  })

  it('keeps a sentence that happens to end on the next line’s first word', () => {
    // The suffix rule only fires on a line that was itself a loop, so ordinary
    // speech running one word into the next line is left alone.
    const out = dropRunawayRepeats(
      transcript([
        { start: 0, end: 3, text: 'and then we went home' },
        { start: 3, end: 6, text: 'home is where I left it' },
        { start: 6, end: 9, text: 'it' },
      ]),
    )

    expect(out.segments).toHaveLength(3)
  })

  it('reads through punctuation, which a loop varies and speech does not', () => {
    const out = dropRunawayRepeats(
      transcript([
        { start: 0, end: 3, text: 'okay.' },
        { start: 3, end: 6, text: 'Okay!' },
      ]),
    )

    expect(out.segments).toHaveLength(1)
  })

  it('throws away the word timings of a line it rewrote', () => {
    // The timings inside a loop describe words that were never said. Keeping
    // them would put a word-level cut in the middle of a fiction.
    const out = dropRunawayRepeats(
      transcript([{ start: 0, end: 9, text: 'go go go go' }]),
    )

    expect(out.segments[0]!.words).toEqual([])
  })

  it('keeps the word timings of a line it did not touch', () => {
    const out = dropRunawayRepeats(
      transcript([{ start: 0, end: 3, text: 'perfectly ordinary speech' }]),
    )

    expect(out.segments[0]!.words).toHaveLength(1)
  })

  it('rebuilds the whole-transcript text from what survived', () => {
    const out = dropRunawayRepeats(
      transcript([
        { start: 0, end: 3, text: 'hello' },
        { start: 3, end: 6, text: 'bye bye bye bye' },
      ]),
    )

    expect(out.text).toBe('hello bye')
  })

  it('drops a line with nothing in it', () => {
    const out = dropRunawayRepeats(
      transcript([
        { start: 0, end: 3, text: '   ' },
        { start: 3, end: 6, text: 'real words' },
      ]),
    )

    expect(out.segments).toHaveLength(1)
  })

  it('has nothing to do with an empty transcript', () => {
    expect(dropRunawayRepeats(transcript([])).segments).toEqual([])
  })
})

describe('the spoken language preference', () => {
  function storage(): Storage {
    const held = new Map<string, string>()
    return {
      getItem: (key) => held.get(key) ?? null,
      setItem: (key, value) => void held.set(key, value),
      removeItem: (key) => void held.delete(key),
      clear: () => held.clear(),
      key: () => null,
      length: 0,
    } as Storage
  }

  it('starts on detect-it-yourself, which is right most of the time', () => {
    expect(readSpokenLanguage(storage())).toBe('')
  })

  it('remembers a choice', () => {
    const held = storage()
    writeSpokenLanguage('ta', held)
    expect(readSpokenLanguage(held)).toBe('ta')
  })

  it('refuses a code that is not on the menu', () => {
    const held = storage()
    held.setItem(LANGUAGE_STORAGE_KEY, 'klingon')
    expect(readSpokenLanguage(held)).toBe('')
  })

  it('survives storage being absent or throwing outright', () => {
    expect(readSpokenLanguage(null)).toBe('')
    expect(() => writeSpokenLanguage('ta', null)).not.toThrow()

    const hostile = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    } as unknown as Storage
    expect(readSpokenLanguage(hostile)).toBe('')
    expect(() => writeSpokenLanguage('ta', hostile)).not.toThrow()
  })

  it('offers mixed, for speech that switches between two languages', () => {
    // Neither of the alternatives reads Tamil with English words in it: pinning
    // one mangles half of them, detecting once commits the file to the opening.
    const held = storage()
    writeSpokenLanguage(MIXED, held)
    expect(readSpokenLanguage(held)).toBe(MIXED)
    expect(SPOKEN_LANGUAGES.some((option) => option.code === MIXED)).toBe(true)
  })

  it('offers detect first, since it is the default', () => {
    expect(SPOKEN_LANGUAGES[0]!.code).toBe('')
  })
})
