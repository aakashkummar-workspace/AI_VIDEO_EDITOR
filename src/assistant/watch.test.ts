import { describe, expect, it } from 'vitest'
import { parseShots } from './watch'

describe('reading the model back', () => {
  it('reads a line per shot', () => {
    const shots = parseShots(
      [
        '0-4.5: A woman sits at a desk, a window behind her.',
        '4.5-9: Close on her hands turning the pages of a notebook.',
      ].join('\n'),
      30,
    )

    expect(shots).toEqual([
      {
        startSeconds: 0,
        endSeconds: 4.5,
        text: 'A woman sits at a desk, a window behind her.',
      },
      {
        startSeconds: 4.5,
        endSeconds: 9,
        text: 'Close on her hands turning the pages of a notebook.',
      },
    ])
  })

  it('ignores anything that is not a shot line', () => {
    // A model asked for a strict format usually obliges and sometimes adds a
    // sentence in front of it. That sentence is not a shot.
    const shots = parseShots(
      ['Here is what I can see:', '', '0-3: A title card.', 'Hope that helps.'].join(
        '\n',
      ),
      30,
    )

    expect(shots).toHaveLength(1)
    expect(shots[0]!.text).toBe('A title card.')
  })

  it('clamps a shot claiming to run past the end of the file', () => {
    // The one thing worse than no description is one with wrong times in it: a
    // cut planned against those would land outside the footage.
    const shots = parseShots('0-90: A long hold.', 30)
    expect(shots[0]!.endSeconds).toBe(30)
  })

  it('drops a shot that covers no time', () => {
    expect(parseShots('5-5: Nothing.', 30)).toEqual([])
    expect(parseShots('9-4: Backwards.', 30)).toEqual([])
  })

  it('drops a shot with nothing said about it', () => {
    expect(parseShots('0-4:    ', 30)).toEqual([])
  })

  it('has nothing to say about an empty reply', () => {
    expect(parseShots('', 30)).toEqual([])
  })
})
