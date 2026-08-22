import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearSourceFiles,
  getSourceFile,
  hasSourceFile,
  registerSourceFile,
  requireSourceFile,
} from './sourceRegistry'
import { useTimelineStore } from './store'
import { clipDuration, type Source } from './types'

const SECOND = 1_000_000

const source: Source = {
  id: 'src-a',
  name: 'a.mp4',
  durationMicros: 10 * SECOND,
  width: 320,
  height: 240,
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

function clips() {
  return store().project.videoTrack.clips
}

function addBaseClip() {
  store().addClip({
    id: 'clip-1',
    sourceId: source.id,
    sourceInMicros: SECOND,
    sourceOutMicros: 3 * SECOND,
    timelineStartMicros: 0,
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
    expect(clipDuration(clips()[0]!)).toBe(2 * SECOND)
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
      store().moveClip({ clipId: 'nope', timelineStartMicros: 0 }),
    ).toThrow(/No clip/)

    expect(store().project).toBe(before)
    expect(store().past).toHaveLength(undoDepth)
  })
})

describe('undo and redo', () => {
  it('treats one operation as one undo step', () => {
    addBaseClip()
    store().moveClip({ clipId: 'clip-1', timelineStartMicros: 5 * SECOND })
    store().trimClipEnd({ clipId: 'clip-1', timelineMicros: 6 * SECOND })

    expect(store().past).toHaveLength(3)

    store().undo()
    expect(clipDuration(clips()[0]!)).toBe(2 * SECOND)
    expect(clips()[0]!.timelineStartMicros).toBe(5 * SECOND)

    store().undo()
    expect(clips()[0]!.timelineStartMicros).toBe(0)

    store().undo()
    expect(clips()).toEqual([])
    expect(store().canUndo()).toBe(false)
  })

  it('redoes back to exactly the same state', () => {
    addBaseClip()
    store().splitClipAt({ timelineMicros: SECOND, newClipId: 'clip-1b' })
    const afterSplit = store().project

    store().undo()
    expect(clips()).toHaveLength(1)

    store().redo()
    expect(store().project).toEqual(afterSplit)
    expect(store().canRedo()).toBe(false)
  })

  it('walks the whole history and back', () => {
    addBaseClip()
    store().splitClipAt({ timelineMicros: SECOND, newClipId: 'clip-1b' })
    store().moveClip({ clipId: 'clip-1b', timelineStartMicros: 6 * SECOND })
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
    store().moveClip({ clipId: 'clip-1', timelineStartMicros: 5 * SECOND })
    store().undo()
    expect(store().canRedo()).toBe(true)

    store().trimClipEnd({ clipId: 'clip-1', timelineMicros: SECOND })

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

    store().splitClipAt({ timelineMicros: 9 * SECOND, newClipId: 'nothing' })

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

    store().trimClipStart({ clipId: 'clip-1', timelineMicros: 250_000 })
    store().trimClipEnd({ clipId: 'clip-1', timelineMicros: 1_750_000 })
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
      videoTrack: { clips: [] },
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
