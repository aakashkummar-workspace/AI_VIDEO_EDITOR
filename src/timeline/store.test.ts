import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSourceFiles,
  getSourceFile,
  hasSourceFile,
  registerSourceFile,
  requireSourceFile,
} from './sourceRegistry'
import { useTimelineStore } from './store'
import {
  MAIN_TEXT_TRACK_ID,
  MAIN_VIDEO_TRACK_ID,
  segmentDuration,
  type Segment,
  type Source,
  type TextContent,
} from './types'

const SECOND = 1_000_000

const source: Source = {
  id: 'src-a',
  name: 'a.mp4',
  durationMicros: 10 * SECOND,
  width: 320,
  height: 240,
  rotation: 0,
}

/**
 * Walks a value and returns the paths of anything that is not plain JSON:
 * class instances (File, Blob, Map), functions, dates, and so on.
 */
function nonJsonValues(value: unknown, path = '$'): string[] {
  if (value === null) return []

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return []
  }

  if (typeof value !== 'object') return [`${path}: ${typeof value}`]

  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      nonJsonValues(item, `${path}[${index}]`),
    )
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return [`${path}: ${value.constructor?.name ?? 'unknown class'}`]
  }

  return Object.entries(value).flatMap(([key, item]) =>
    nonJsonValues(item, `${path}.${key}`),
  )
}

function store() {
  return useTimelineStore.getState()
}

/** The segments on the main video row, which most of these tests work on. */
function clips(): Segment[] {
  const track = store().project.tracks.find(
    (candidate) => candidate.id === MAIN_VIDEO_TRACK_ID,
  )
  if (!track) throw new Error('test setup: no video track')
  return track.segments
}

function addBaseClip() {
  store().addSegment({
    trackId: MAIN_VIDEO_TRACK_ID,
    segment: {
      id: 'clip-1',
      timelineStartMicros: 0,
      content: {
        kind: 'video',
        sourceId: source.id,
        sourceInMicros: SECOND,
        sourceOutMicros: 3 * SECOND,
      },
    },
  })
}

beforeEach(() => {
  store().reset()
  store().addSource(source)
  clearSourceFiles()
})

describe('store', () => {
  it('starts empty', () => {
    expect(clips()).toEqual([])
    expect(store().canUndo()).toBe(false)
    expect(store().canRedo()).toBe(false)
  })

  it('applies operations to the project', () => {
    addBaseClip()

    expect(clips()).toHaveLength(1)
    expect(segmentDuration(clips()[0]!)).toBe(2 * SECOND)
  })

  it('holds nothing but plain JSON', () => {
    addBaseClip()
    const { project } = store()

    expect(JSON.parse(JSON.stringify(project))).toEqual(project)
  })

  it('leaves state untouched when an operation throws', () => {
    addBaseClip()
    const before = store().project
    const undoDepth = store().past.length

    expect(() =>
      store().moveSegment({ segmentId: 'nope', timelineStartMicros: 0 }),
    ).toThrow(/No segment/)

    expect(store().project).toBe(before)
    expect(store().past).toHaveLength(undoDepth)
  })
})

describe('undo and redo', () => {
  it('treats one operation as one undo step', () => {
    addBaseClip()
    store().moveSegment({ segmentId: 'clip-1', timelineStartMicros: 5 * SECOND })
    store().trimSegmentEnd({ segmentId: 'clip-1', timelineMicros: 6 * SECOND })

    expect(store().past).toHaveLength(3)

    store().undo()
    expect(segmentDuration(clips()[0]!)).toBe(2 * SECOND)
    expect(clips()[0]!.timelineStartMicros).toBe(5 * SECOND)

    store().undo()
    expect(clips()[0]!.timelineStartMicros).toBe(0)

    store().undo()
    expect(clips()).toEqual([])
    expect(store().canUndo()).toBe(false)
  })

  it('redoes back to exactly the same state', () => {
    addBaseClip()
    store().splitSegmentAt({ timelineMicros: SECOND, newSegmentId: 'clip-1b' })
    const afterSplit = store().project

    store().undo()
    expect(clips()).toHaveLength(1)

    store().redo()
    expect(store().project).toEqual(afterSplit)
    expect(store().canRedo()).toBe(false)
  })

  it('walks the whole history and back', () => {
    addBaseClip()
    store().splitSegmentAt({ timelineMicros: SECOND, newSegmentId: 'clip-1b' })
    store().moveSegment({ segmentId: 'clip-1b', timelineStartMicros: 6 * SECOND })
    const final = store().project

    store().undo()
    store().undo()
    store().undo()
    expect(clips()).toEqual([])

    store().redo()
    store().redo()
    store().redo()
    expect(store().project).toEqual(final)
  })

  it('drops the redo stack once a new edit is made', () => {
    addBaseClip()
    store().moveSegment({ segmentId: 'clip-1', timelineStartMicros: 5 * SECOND })
    store().undo()
    expect(store().canRedo()).toBe(true)

    store().trimSegmentEnd({ segmentId: 'clip-1', timelineMicros: SECOND })

    expect(store().canRedo()).toBe(false)
    expect(store().future).toEqual([])
  })

  it('does nothing when there is nothing to undo or redo', () => {
    const before = store().project

    store().undo()
    store().redo()

    expect(store().project).toBe(before)
  })

  it('does not spend an undo step on a no-op split', () => {
    addBaseClip()
    const depth = store().past.length

    store().splitSegmentAt({ timelineMicros: 9 * SECOND, newSegmentId: 'nothing' })

    expect(store().past).toHaveLength(depth)
    expect(clips()).toHaveLength(1)
  })

  it('does not make registering a source undoable', () => {
    const depth = store().past.length
    store().addSource({ ...source, id: 'src-b', name: 'b.mp4' })

    expect(store().past).toHaveLength(depth)
    expect(Object.keys(store().project.sources).sort()).toEqual([
      'src-a',
      'src-b',
    ])
  })

  it('undoes a trim back to the exact original microseconds', () => {
    addBaseClip()
    const before = structuredClone(clips()[0]!)

    store().trimSegmentStart({ segmentId: 'clip-1', timelineMicros: 250_000 })
    store().trimSegmentEnd({ segmentId: 'clip-1', timelineMicros: 1_750_000 })
    store().undo()
    store().undo()

    expect(clips()[0]).toEqual(before)
  })
})

describe('source registry', () => {
  it('keeps files out of the store, keyed by the same id', () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'a.mp4', {
      type: 'video/mp4',
    })
    registerSourceFile(source.id, file)
    addBaseClip()

    expect(getSourceFile(source.id)).toBe(file)
    expect(hasSourceFile(source.id)).toBe(true)

    // The project knows the metadata; the File itself is nowhere in it.
    expect(store().project.sources[source.id]).toEqual(source)
    expect(nonJsonValues(store().project)).toEqual([])
  })

  it('would notice a File smuggled into the project', () => {
    // Guards the check above: it has to be able to fail.
    const smuggled = {
      sources: { 'src-a': { file: new File([], 'a.mp4') } },
      tracks: [],
    }

    expect(nonJsonValues(smuggled)).toEqual(['$.sources.src-a.file: File'])
  })

  it('reports a missing file rather than returning undefined silently', () => {
    expect(() => requireSourceFile('src-missing')).toThrow(/No file registered/)
  })

  it('survives a store reset, because it is not store state', () => {
    const file = new File([], 'a.mp4', { type: 'video/mp4' })
    registerSourceFile(source.id, file)

    store().reset()

    expect(clips()).toEqual([])
    expect(getSourceFile(source.id)).toBe(file)
  })
})

describe('coalescing continuous edits', () => {
  const overlay: Segment = {
    id: 'text-1',
    timelineStartMicros: 0,
    content: {
      kind: 'text',
      content: '',
      x: 10,
      y: 20,
      sizePx: 32,
      color: '#ffffff',
      durationMicros: 2 * SECOND,
    },
  }

  /** The style of the one caption these tests type into. */
  function caption(): TextContent {
    const track = store().project.tracks.find(
      (candidate) => candidate.id === MAIN_TEXT_TRACK_ID,
    )
    const segment = track?.segments[0]
    if (!segment || segment.content.kind !== 'text') {
      throw new Error('test setup: no caption')
    }
    return segment.content
  }

  function type(text: string) {
    for (let length = 1; length <= text.length; length++) {
      store().setTextStyle({
        segmentId: overlay.id,
        content: text.slice(0, length),
      })
    }
  }

  beforeEach(() => {
    store().addSegment({ trackId: MAIN_TEXT_TRACK_ID, segment: overlay })
  })

  it('treats a run of typing as one undo step', () => {
    const depth = store().past.length
    type('CAPTION')

    expect(caption().content).toBe('CAPTION')
    // Seven changes, one step - not one step per letter.
    expect(store().past).toHaveLength(depth + 1)
  })

  it('undoes the whole run at once, back to where it started', () => {
    type('CAPTION')
    store().undo()

    expect(caption().content).toBe('')
  })

  it('redoes the whole run at once', () => {
    type('CAPTION')
    const typed = store().project
    store().undo()
    store().redo()

    expect(store().project).toEqual(typed)
  })

  it('starts a new step for a different field', () => {
    const depth = store().past.length
    type('AB')
    store().setTextStyle({ segmentId: overlay.id, x: 99 })

    expect(store().past).toHaveLength(depth + 2)

    // Undoing the nudge leaves the typing intact.
    store().undo()
    expect(caption().x).toBe(10)
    expect(caption().content).toBe('AB')
  })

  it('starts a new step after leaving the field', () => {
    const depth = store().past.length
    type('AB')
    store().endCoalescing()
    type('CD')

    expect(store().past).toHaveLength(depth + 2)
    store().undo()
    expect(caption().content).toBe('AB')
  })

  it('starts a new step after any other edit', () => {
    const depth = store().past.length
    type('AB')
    store().moveSegment({ segmentId: overlay.id, timelineStartMicros: SECOND })
    type('CD')

    expect(store().past).toHaveLength(depth + 3)
  })

  it('does not merge across an undo', () => {
    type('AB')
    store().undo()
    type('CD')

    // The redo of the first run is gone, and the second run stands alone.
    expect(store().canRedo()).toBe(false)
    store().undo()
    expect(caption().content).toBe('')
  })
})
