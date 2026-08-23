import { describe, expect, it } from 'vitest'
import {
  DRAFT_VERSION,
  draftFileName,
  isDraftError,
  parseDraft,
  parseDraftText,
  serializeDraft,
  toDraft,
} from './draft'
import {
  addEffect,
  addEffectKeyframe,
  addKeyframe,
  addSegment,
  addSource,
  addTrack,
  setComposition,
  setSegmentTransform,
} from './operations'
import {
  MAIN_TEXT_TRACK_ID,
  MAIN_VIDEO_TRACK_ID,
  emptyProject,
  type Project,
  type Source,
} from './types'

const SECOND = 1_000_000

const source: Source = {
  id: 'src-a',
  name: 'holiday.mp4',
  durationMicros: 10 * SECOND,
  width: 1920,
  height: 1080,
  rotation: 90,
}

/** A project using every feature, so the round trip has something to lose. */
function richProject(): Project {
  let project = setComposition(addSource(emptyProject(), source), {
    width: 1080,
    height: 1920,
  })

  project = addTrack(project, { id: 'video-2', kind: 'video' })

  project = addSegment(project, {
    trackId: MAIN_VIDEO_TRACK_ID,
    segment: {
      id: 'clip-1',
      timelineStartMicros: 0,
      content: {
        kind: 'video',
        sourceId: source.id,
        sourceInMicros: 1 * SECOND,
        sourceOutMicros: 4 * SECOND,
      },
    },
  })

  project = addSegment(project, {
    trackId: 'video-2',
    segment: {
      id: 'clip-2',
      timelineStartMicros: 1 * SECOND,
      content: {
        kind: 'video',
        sourceId: source.id,
        sourceInMicros: 0,
        sourceOutMicros: 2 * SECOND,
      },
    },
  })

  project = addSegment(project, {
    trackId: MAIN_TEXT_TRACK_ID,
    segment: {
      id: 'text-1',
      timelineStartMicros: 500_000,
      content: {
        kind: 'text',
        content: 'Hello',
        x: 40,
        y: 100,
        sizePx: 64,
        color: '#ff00ff',
        durationMicros: 2 * SECOND,
      },
    },
  })

  project = setSegmentTransform(project, { segmentId: 'clip-2', scale: 0.4 })
  project = addKeyframe(project, {
    segmentId: 'clip-2',
    property: 'opacity',
    offsetMicros: 0,
    value: 0,
  })
  project = addKeyframe(project, {
    segmentId: 'clip-2',
    property: 'opacity',
    offsetMicros: 1 * SECOND,
    value: 1,
  })

  project = addEffect(project, {
    segmentId: 'clip-1',
    id: 'fx-1',
    kind: 'grayscale',
    amount: 0.5,
  })
  project = addEffectKeyframe(project, {
    segmentId: 'clip-1',
    effectId: 'fx-1',
    offsetMicros: 0,
    value: 0,
  })

  return project
}

/** The draft of a project, with one field replaced somewhere inside it. */
function draftWith(change: (draft: Record<string, never>) => void): unknown {
  const draft = JSON.parse(JSON.stringify(toDraft(richProject())))
  change(draft)
  return draft
}

describe('round trip', () => {
  it('comes back exactly as it went in', () => {
    const project = richProject()
    expect(parseDraftText(serializeDraft(project))).toEqual(project)
  })

  it('survives an empty project', () => {
    expect(parseDraftText(serializeDraft(emptyProject()))).toEqual(
      emptyProject(),
    )
  })

  it('keeps transforms, keyframes and effects', () => {
    const back = parseDraftText(serializeDraft(richProject()))
    const clip2 = back.tracks
      .flatMap((track) => track.segments)
      .find((segment) => segment.id === 'clip-2')!
    const clip1 = back.tracks
      .flatMap((track) => track.segments)
      .find((segment) => segment.id === 'clip-1')!

    expect(clip2.transform).toEqual({ scale: 0.4 })
    expect(clip2.keyframes!.opacity).toHaveLength(2)
    expect(clip1.effects).toEqual([
      {
        id: 'fx-1',
        kind: 'grayscale',
        amount: 0.5,
        keyframes: [{ offsetMicros: 0, value: 0 }],
      },
    ])
  })

  it('does not share structure with the project it came from', () => {
    const project = richProject()
    const draft = toDraft(project)

    expect(draft.project).not.toBe(project)
    expect(draft.project.tracks[0]).not.toBe(project.tracks[0])
  })

  it('writes the version it is reading', () => {
    expect(toDraft(emptyProject())).toMatchObject({
      kind: 'video-editor-draft',
      version: DRAFT_VERSION,
    })
  })
})

describe('refusing a draft it cannot read', () => {
  function expectRefusal(value: unknown, pattern: RegExp) {
    let thrown: unknown
    try {
      parseDraft(value)
    } catch (error) {
      thrown = error
    }

    expect(thrown, 'nothing was thrown').toBeDefined()
    expect(isDraftError(thrown)).toBe(true)
    expect((thrown as Error).message).toMatch(pattern)
  }

  it('refuses something that is not a project file', () => {
    expectRefusal({ hello: 'world' }, /not a project file/)
    expectRefusal(null, /is missing or is not an object/)
    expectRefusal([], /is missing or is not an object/)
  })

  it('refuses a version it does not understand', () => {
    expectRefusal(
      draftWith((draft) => {
        ;(draft as Record<string, unknown>).version = DRAFT_VERSION + 1
      }),
      /newer version/,
    )
  })

  it('reads a draft written by an older version', () => {
    const older = draftWith((draft) => {
      ;(draft as Record<string, unknown>).version = 0
    })
    expect(parseDraft(older).tracks).toHaveLength(3)
  })

  it('refuses text that is not JSON', () => {
    let thrown: unknown
    try {
      parseDraftText('{ not json')
    } catch (error) {
      thrown = error
    }
    expect(isDraftError(thrown)).toBe(true)
    expect((thrown as Error).message).toMatch(/valid JSON/)
  })

  it('refuses a fractional time', () => {
    expectRefusal(
      draftWith((draft) => {
        const project = (draft as Record<string, any>).project
        project.tracks[0].segments[0].timelineStartMicros = 1.5
      }),
      /whole number of microseconds/,
    )
  })

  it('refuses a segment pointing at a source that is not there', () => {
    expectRefusal(
      draftWith((draft) => {
        const project = (draft as Record<string, any>).project
        project.tracks[0].segments[0].content.sourceId = 'gone'
      }),
      /points at a source the draft does not list/,
    )
  })

  it('refuses two segments sharing an id', () => {
    expectRefusal(
      draftWith((draft) => {
        const project = (draft as Record<string, any>).project
        project.tracks[1].segments[0].id = 'clip-1'
      }),
      /share the id/,
    )
  })

  it('refuses a segment on a row that cannot hold it', () => {
    expectRefusal(
      draftWith((draft) => {
        const project = (draft as Record<string, any>).project
        // Move the caption onto the video row.
        const text = project.tracks[2].segments.pop()
        project.tracks[0].segments.push(text)
      }),
      /cannot hold it|overlap/,
    )
  })

  it('refuses overlapping segments on a video row', () => {
    expectRefusal(
      draftWith((draft) => {
        const project = (draft as Record<string, any>).project
        project.tracks[0].segments.push({
          id: 'clip-3',
          timelineStartMicros: 0,
          content: {
            kind: 'video',
            sourceId: 'src-a',
            sourceInMicros: 0,
            sourceOutMicros: 1_000_000,
          },
        })
      }),
      /overlap/,
    )
  })

  it('refuses a segment with no duration', () => {
    expectRefusal(
      draftWith((draft) => {
        const project = (draft as Record<string, any>).project
        project.tracks[0].segments[0].content.sourceOutMicros =
          project.tracks[0].segments[0].content.sourceInMicros
      }),
      /no duration/,
    )
  })

  it('refuses an effect kind it does not know', () => {
    expectRefusal(
      draftWith((draft) => {
        const project = (draft as Record<string, any>).project
        project.tracks[0].segments[0].effects[0].kind = 'kaleidoscope'
      }),
      /effect this version does not know/,
    )
  })

  it('refuses a row kind it does not know', () => {
    expectRefusal(
      draftWith((draft) => {
        const project = (draft as Record<string, any>).project
        project.tracks[0].kind = 'audio'
      }),
      /row this version does not know/,
    )
  })

  it('refuses a composition that is not whole pixels', () => {
    expectRefusal(
      draftWith((draft) => {
        ;(draft as Record<string, any>).project.composition.width = 100.5
      }),
      /whole number of pixels/,
    )
  })

  it('refuses a rotation that is not a right angle', () => {
    expectRefusal(
      draftWith((draft) => {
        ;(draft as Record<string, any>).project.sources['src-a'].rotation = 45
      }),
      /must be 0, 90, 180 or 270/,
    )
  })
})

describe('what a draft leaves out', () => {
  it('drops fields it does not recognise instead of carrying them through', () => {
    const tampered = draftWith((draft) => {
      const project = (draft as Record<string, any>).project
      project.tracks[0].segments[0].somethingElse = 'ignored'
      project.sources['src-a'].path = '/home/someone/holiday.mp4'
    })

    const back = parseDraft(tampered)
    expect(back.tracks[0]!.segments[0]).not.toHaveProperty('somethingElse')
    expect(back.sources['src-a']).not.toHaveProperty('path')
  })

  it('holds no file, only what a source looks like', () => {
    const back = parseDraftText(serializeDraft(richProject()))

    expect(back.sources['src-a']).toEqual(source)
    expect(Object.keys(back.sources['src-a']!).sort()).toEqual([
      'durationMicros',
      'height',
      'id',
      'name',
      'rotation',
      'width',
    ])
  })

  it('sorts segments even if the file had them out of order', () => {
    const shuffled = draftWith((draft) => {
      const project = (draft as Record<string, any>).project
      project.tracks[0].segments.unshift({
        id: 'clip-late',
        timelineStartMicros: 5_000_000,
        content: {
          kind: 'video',
          sourceId: 'src-a',
          sourceInMicros: 0,
          sourceOutMicros: 1_000_000,
        },
      })
    })

    expect(parseDraft(shuffled).tracks[0]!.segments.map((s) => s.id)).toEqual([
      'clip-1',
      'clip-late',
    ])
  })
})

describe('draftFileName', () => {
  it('is named after the first source', () => {
    expect(draftFileName(richProject())).toBe('holiday.draft.json')
  })

  it('falls back when there is nothing to name it after', () => {
    expect(draftFileName(emptyProject())).toBe('timeline.draft.json')
  })
})
