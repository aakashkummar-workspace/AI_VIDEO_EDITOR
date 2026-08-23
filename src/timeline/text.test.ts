import { describe, expect, it } from 'vitest'
import { parseDraftText, serializeDraft } from './draft'
import { addSegment, setTextStyle } from './operations'
import {
  FONT_FAMILIES,
  MAIN_TEXT_TRACK_ID,
  OVERLAY_FONT_FAMILY,
  emptyProject,
  findSegment,
  fontStringFor,
  textContent,
  textLines,
  type Project,
  type TextContent,
} from './types'

const SECOND = 1_000_000

function withCaption(): Project {
  return addSegment(emptyProject(), {
    trackId: MAIN_TEXT_TRACK_ID,
    segment: {
      id: 'text-1',
      timelineStartMicros: 0,
      content: {
        kind: 'text',
        content: 'Hello',
        x: 100,
        y: 200,
        sizePx: 48,
        color: '#ffffff',
        durationMicros: 2 * SECOND,
      },
    },
  })
}

function style(project: Project): TextContent {
  const found = findSegment(project, 'text-1')
  const text = found ? textContent(found.segment) : undefined
  if (!text) throw new Error('test setup: no caption')
  return text
}

describe('fontStringFor', () => {
  it('is a plain size and family by default', () => {
    expect(fontStringFor(style(withCaption()))).toBe(
      `48px ${OVERLAY_FONT_FAMILY}`,
    )
  })

  it('puts the style and weight in the order CSS wants', () => {
    const project = setTextStyle(withCaption(), {
      segmentId: 'text-1',
      bold: true,
      italic: true,
      fontFamily: 'serif',
    })

    expect(fontStringFor(style(project))).toBe('italic bold 48px serif')
  })

  it('is what the renderer measures AND draws with', () => {
    // One function, so a background box cannot be laid out for a different
    // font from the one the glyphs end up in.
    const project = setTextStyle(withCaption(), {
      segmentId: 'text-1',
      bold: true,
    })

    expect(fontStringFor(style(project))).toContain('bold')
  })
})

describe('textLines', () => {
  it('is one line for ordinary text', () => {
    expect(textLines(style(withCaption()))).toEqual(['Hello'])
  })

  it('splits on newlines, because a caption is usually more than one', () => {
    const project = setTextStyle(withCaption(), {
      segmentId: 'text-1',
      content: 'first\nsecond\nthird',
    })

    expect(textLines(style(project))).toEqual(['first', 'second', 'third'])
  })
})

describe('setTextStyle', () => {
  it('leaves every new field absent until it is asked for', () => {
    const text = style(withCaption())

    expect(text.fontFamily).toBeUndefined()
    expect(text.bold).toBeUndefined()
    expect(text.align).toBeUndefined()
    expect(text.outlineWidthPx).toBeUndefined()
    expect(text.backgroundColor).toBeUndefined()
  })

  it('accepts every font it offers, and nothing else', () => {
    for (const fontFamily of FONT_FAMILIES) {
      expect(() =>
        setTextStyle(withCaption(), { segmentId: 'text-1', fontFamily }),
      ).not.toThrow()
    }

    expect(() =>
      setTextStyle(withCaption(), {
        segmentId: 'text-1',
        fontFamily: 'Comic Sans MS',
      }),
    ).toThrow(/Unknown font/)
  })

  it('accepts every alignment it offers, and nothing else', () => {
    expect(
      style(
        setTextStyle(withCaption(), { segmentId: 'text-1', align: 'center' }),
      ).align,
    ).toBe('center')

    expect(() =>
      setTextStyle(withCaption(), {
        segmentId: 'text-1',
        align: 'justify' as never,
      }),
    ).toThrow(/Unknown alignment/)
  })

  it('rounds the pixel measurements and refuses negative ones', () => {
    const project = setTextStyle(withCaption(), {
      segmentId: 'text-1',
      outlineWidthPx: 2.6,
      shadowBlurPx: 4.2,
    })

    expect(style(project).outlineWidthPx).toBe(3)
    expect(style(project).shadowBlurPx).toBe(4)

    for (const field of [
      'outlineWidthPx',
      'shadowBlurPx',
      'backgroundPaddingPx',
    ] as const) {
      expect(() =>
        setTextStyle(withCaption(), { segmentId: 'text-1', [field]: -1 }),
      ).toThrow(/cannot be negative/)
    }
  })

  it('takes a background off when its colour is cleared', () => {
    let project = setTextStyle(withCaption(), {
      segmentId: 'text-1',
      backgroundColor: '#000000',
      backgroundPaddingPx: 8,
    })
    expect(style(project).backgroundColor).toBe('#000000')

    project = setTextStyle(project, {
      segmentId: 'text-1',
      backgroundColor: '',
    })
    expect(style(project).backgroundColor).toBeUndefined()
  })

  it('changes only what it is given', () => {
    let project = setTextStyle(withCaption(), {
      segmentId: 'text-1',
      bold: true,
      outlineWidthPx: 4,
    })
    project = setTextStyle(project, { segmentId: 'text-1', italic: true })

    const text = style(project)
    expect(text.bold).toBe(true)
    expect(text.italic).toBe(true)
    expect(text.outlineWidthPx).toBe(4)
    expect(text.content).toBe('Hello')
  })

  it('still refuses a size of nothing', () => {
    expect(() =>
      setTextStyle(withCaption(), { segmentId: 'text-1', sizePx: 0 }),
    ).toThrow(/positive size/)
  })
})

describe('styled text in a draft', () => {
  it('survives the round trip', () => {
    const project = setTextStyle(withCaption(), {
      segmentId: 'text-1',
      content: 'two\nlines',
      fontFamily: 'monospace',
      bold: true,
      italic: true,
      align: 'center',
      outlineWidthPx: 3,
      outlineColor: '#ff0000',
      shadowBlurPx: 6,
      shadowColor: '#000000',
      backgroundColor: '#101010',
      backgroundPaddingPx: 12,
    })

    expect(parseDraftText(serializeDraft(project))).toEqual(project)
  })

  it('leaves the new fields out entirely when unused', () => {
    const draft = JSON.parse(serializeDraft(withCaption()))
    const row = draft.project.tracks.find(
      (track: { id: string }) => track.id === MAIN_TEXT_TRACK_ID,
    )
    const content = row.segments[0].content

    expect(Object.keys(content).sort()).toEqual([
      'color',
      'content',
      'durationMicros',
      'kind',
      'sizePx',
      'x',
      'y',
    ])
  })

  it('refuses a font or an alignment this version does not know', () => {
    for (const [field, value, pattern] of [
      ['fontFamily', 'Comic Sans MS', /font this version does not know/],
      ['align', 'justify', /alignment this version does not know/],
    ] as const) {
      const draft = JSON.parse(serializeDraft(withCaption()))
      const row = draft.project.tracks.find(
        (track: { id: string }) => track.id === MAIN_TEXT_TRACK_ID,
      )
      row.segments[0].content[field] = value

      expect(() => parseDraftText(JSON.stringify(draft))).toThrow(pattern)
    }
  })

  it('refuses a negative measurement', () => {
    const draft = JSON.parse(serializeDraft(withCaption()))
    const row = draft.project.tracks.find(
      (track: { id: string }) => track.id === MAIN_TEXT_TRACK_ID,
    )
    row.segments[0].content.outlineWidthPx = -4

    expect(() => parseDraftText(JSON.stringify(draft))).toThrow(/negative/)
  })
})
