import { describe, expect, it } from 'vitest'
import { parseDraftText, serializeDraft } from './draft'
import { setComposition, setExportSettings } from './operations'
import {
  DEFAULT_EXPORT_SETTINGS,
  emptyProject,
  exportDimensions,
  exportSettingsOf,
  type Composition,
} from './types'

const LANDSCAPE: Composition = { width: 1920, height: 1080 }
const PORTRAIT: Composition = { width: 1080, height: 1920 }
const SQUARE: Composition = { width: 1000, height: 1000 }

describe('exportSettingsOf', () => {
  it('is the defaults for a project that has never been asked', () => {
    expect(exportSettingsOf(emptyProject())).toEqual(DEFAULT_EXPORT_SETTINGS)
    expect(DEFAULT_EXPORT_SETTINGS.heightPx).toBeNull()
  })

  it('fills in whichever half was never set', () => {
    const project = setExportSettings(emptyProject(), { heightPx: 720 })

    expect(exportSettingsOf(project)).toEqual({
      heightPx: 720,
      quality: DEFAULT_EXPORT_SETTINGS.quality,
    })
  })
})

describe('exportDimensions', () => {
  it('is the composition when no height is chosen', () => {
    expect(exportDimensions(LANDSCAPE, { heightPx: null, quality: 'high' })).toEqual(
      LANDSCAPE,
    )
  })

  it('keeps the shape of the composition, whatever the height', () => {
    expect(exportDimensions(LANDSCAPE, { heightPx: 720, quality: 'high' })).toEqual(
      { width: 1280, height: 720 },
    )
    expect(exportDimensions(LANDSCAPE, { heightPx: 2160, quality: 'high' })).toEqual(
      { width: 3840, height: 2160 },
    )
  })

  it('does the same for a portrait composition', () => {
    // 9:16 at 1080 tall is 608 wide, not 1080: the height is what was asked
    // for and the width follows the shape.
    expect(exportDimensions(PORTRAIT, { heightPx: 1080, quality: 'high' })).toEqual(
      { width: 608, height: 1080 },
    )
  })

  it('never returns an odd dimension, which encoders refuse', () => {
    for (const composition of [LANDSCAPE, PORTRAIT, SQUARE, { width: 1001, height: 999 }]) {
      for (const heightPx of [null, 480, 720, 1080, 1440, 2160, 481]) {
        const { width, height } = exportDimensions(composition, {
          heightPx,
          quality: 'high',
        })

        expect(width % 2, `${composition.width}x${composition.height} @${heightPx}`).toBe(0)
        expect(height % 2).toBe(0)
        expect(width).toBeGreaterThan(0)
        expect(height).toBeGreaterThan(0)
      }
    }
  })

  it('scaling up and back down lands where it started', () => {
    const up = exportDimensions(LANDSCAPE, { heightPx: 2160, quality: 'high' })
    const down = exportDimensions(up, { heightPx: 1080, quality: 'high' })

    expect(down).toEqual(LANDSCAPE)
  })
})

describe('setExportSettings', () => {
  it('changes only what it is given', () => {
    let project = setExportSettings(emptyProject(), { heightPx: 1080 })
    project = setExportSettings(project, { quality: 'low' })

    expect(exportSettingsOf(project)).toEqual({
      heightPx: 1080,
      quality: 'low',
    })
  })

  it('takes null back to the composition size', () => {
    let project = setExportSettings(emptyProject(), { heightPx: 480 })
    project = setExportSettings(project, { heightPx: null })

    expect(exportSettingsOf(project).heightPx).toBeNull()
  })

  it('refuses a height that is not a positive whole number', () => {
    for (const heightPx of [0, -720, 720.5]) {
      expect(() => setExportSettings(emptyProject(), { heightPx })).toThrow(
        /positive whole number/,
      )
    }
  })

  it('refuses a quality it does not know', () => {
    expect(() =>
      setExportSettings(emptyProject(), { quality: 'ultra' as never }),
    ).toThrow(/Unknown export quality/)
  })

  it('does not touch the composition it exports from', () => {
    const project = setExportSettings(
      setComposition(emptyProject(), PORTRAIT),
      { heightPx: 2160 },
    )

    expect(project.composition).toEqual(PORTRAIT)
  })
})

describe('export settings in a draft', () => {
  it('survives the round trip', () => {
    const project = setExportSettings(emptyProject(), {
      heightPx: 1440,
      quality: 'very-high',
    })

    expect(parseDraftText(serializeDraft(project))).toEqual(project)
  })

  it('an untouched project saves without the field and reads back the same', () => {
    const project = emptyProject()
    const text = serializeDraft(project)

    expect(JSON.parse(text).project.exportSettings).toBeUndefined()
    expect(parseDraftText(text)).toEqual(project)
  })

  it('refuses a quality an older editor would not understand', () => {
    const draft = JSON.parse(
      serializeDraft(setExportSettings(emptyProject(), { heightPx: 720 })),
    )
    draft.project.exportSettings.quality = 'ludicrous'

    expect(() => parseDraftText(JSON.stringify(draft))).toThrow(
      /quality is one this version does not know/,
    )
  })

  it('refuses a height that is not whole pixels', () => {
    const draft = JSON.parse(
      serializeDraft(setExportSettings(emptyProject(), { heightPx: 720 })),
    )
    draft.project.exportSettings.heightPx = 720.5

    expect(() => parseDraftText(JSON.stringify(draft))).toThrow(
      /whole number of pixels/,
    )
  })
})
