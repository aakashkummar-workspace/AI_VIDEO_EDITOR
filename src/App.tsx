import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { createPlayer } from './player'
import { exportFileName, formatMicros } from './playback'
import {
  applyDrag,
  dragPreviewMicros,
  dragToOperation,
  type DragMode,
  type SegmentDrag,
} from './timeline/dragging'
import {
  DEFAULT_PIXELS_PER_SECOND,
  ZOOM_STEP,
  clampToTimeline,
  clampZoom,
  fitPixelsPerSecond,
  pixelsToMicros,
} from './timeline/layout'
import {
  draftFileName,
  isDraftError,
  parseDraftText,
  serializeDraft,
} from './timeline/draft'
import { timelineDuration } from './timeline/operations'
import {
  clearSourceFiles,
  hasSourceFile,
  registerSourceFile,
} from './timeline/sourceRegistry'
import { useTimelineStore } from './timeline/store'
import {
  BLEND_MODES,
  DEFAULT_TRANSITION_MICROS,
  EFFECT_KINDS,
  MASK_SHAPES,
  EXPORT_HEIGHTS,
  EXPORT_QUALITIES,
  TRANSITION_KINDS,
  effectAmountAt,
  exportDimensions,
  exportSettingsOf,
  findSegment,
  propertyAt,
  segmentDuration,
  segmentRate,
  soundContent,
  sourceHasVideo,
  trackOf,
  videoContent,
  hasKeyframeAt,
  isPropertyAnimated,
  segmentEndMicros,
  textContent,
  type AnimatableProperty,
  type BlendMode,
  type EffectKind,
  type MaskShape,
  type TransitionKind,
  type Project,
  type Segment,
  type TrackKind,
} from './timeline/types'
import Timeline from './ui/Timeline'

/** A gesture in progress. Nothing here has reached the undo history yet. */
type ActiveDrag = {
  segmentId: string
  mode: DragMode
  startClientX: number
  moved: boolean
  trackId: string
}

/** A new text segment lands mid-composition, visible, and lasting two seconds. */
const NEW_OVERLAY_MICROS = 2_000_000

/** How each animatable field is presented and stepped in the panel. */
type PropertyField = {
  property: AnimatableProperty
  label: string
  step: number
  min?: number
  max?: number
}

/** Where a segment is drawn. Meaningless for a segment nobody looks at. */
const TRANSFORM_FIELDS: PropertyField[] = [
  { property: 'scale', label: 'scale', step: 0.05, min: 0.01 },
  { property: 'x', label: 'offset x', step: 1 },
  { property: 'y', label: 'offset y', step: 1 },
  { property: 'opacity', label: 'opacity', step: 0.05, min: 0, max: 1 },
]

/** How loud a segment is. Meaningless for a segment nobody hears. */
const LEVEL_FIELDS: PropertyField[] = [
  { property: 'volume', label: 'volume', step: 0.05, min: 0, max: 4 },
]

const EFFECT_KIND_NAMES = Object.keys(EFFECT_KINDS) as EffectKind[]

/** The speeds offered as one click, since these are the ones people want. */
const RATE_PRESETS = [0.25, 0.5, 1, 2, 4]

/** How each quality is labelled, since the names alone are a bit bare. */
const QUALITY_LABELS: Record<string, string> = {
  low: 'Low - smallest file',
  medium: 'Medium',
  high: 'High',
  'very-high': 'Very high - largest file',
}

/**
 * The furthest into a source any segment reaches.
 *
 * Used when relinking: a file that stops short of this is not the file the
 * draft was made with, however similar its name, and accepting it would leave
 * segments pointing past the end of their own media.
 */
function furthestIntoSource(project: Project, sourceId: string): number {
  let furthest = 0

  for (const track of project.tracks) {
    for (const segment of track.segments) {
      const content = videoContent(segment)
      if (content?.sourceId !== sourceId) continue
      furthest = Math.max(furthest, content.sourceOutMicros)
    }
  }

  return furthest
}

/**
 * Which row the pointer is over, if any.
 *
 * Hit-tested against the DOM rather than tracked in state: the rows are laid
 * out by the browser, and asking it where the pointer is beats keeping a
 * parallel model of the layout in sync with it.
 */
function trackIdAtPoint(clientX: number, clientY: number): string | undefined {
  const element = document.elementFromPoint(clientX, clientY)
  const row = element?.closest('[data-testid=track]')
  return (row as HTMLElement | null)?.dataset.trackId
}

/** Where the playhead falls inside a segment, which is what a keyframe is on. */
function offsetIn(segment: Segment, timelineMicros: number): number {
  return Math.max(0, Math.round(timelineMicros - segment.timelineStartMicros))
}

/** The lowest row of a kind: where a new segment goes without being told. */
function firstTrackId(project: Project, kind: TrackKind): string | undefined {
  return project.tracks.find((track) => track.kind === kind)?.id
}

/** Exclusive end of the last segment on one row. */
function trackEndMicros(project: Project, trackId: string): number {
  const track = project.tracks.find((candidate) => candidate.id === trackId)
  if (!track) return 0
  return track.segments.reduce(
    (end, segment) => Math.max(end, segmentEndMicros(segment)),
    0,
  )
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<ReturnType<typeof createPlayer> | null>(null)
  const exportNameRef = useRef('timeline')

  const project = useTimelineStore((state) => state.project)

  const [error, setError] = useState<string | null>(null)
  const [currentMicros, setCurrentMicros] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [exportPercent, setExportPercent] = useState<number | null>(null)
  /** What the timeline and canvas show mid-drag, before anything is committed. */
  const [previewProject, setPreviewProject] = useState<Project | null>(null)
  const [pixelsPerSecond, setPixelsPerSecond] = useState(
    DEFAULT_PIXELS_PER_SECOND,
  )
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null,
  )
  const [overlayText, setOverlayText] = useState('Text')
  /**
   * Bumped whenever a file is handed to the source registry. The registry is
   * deliberately not store state, so nothing else would tell React that a
   * source stopped being offline.
   */
  const [relinkTick, setRelinkTick] = useState(0)

  const dragRef = useRef<ActiveDrag | null>(null)
  /** A scrub in progress: where it was grabbed, and from what position. */
  const scrubRef = useRef<{ startClientX: number; startMicros: number } | null>(
    null,
  )
  /**
   * The committed project, for the window-level mouse handlers. They are bound
   * once, so they cannot close over the current value; and a gesture is always
   * measured against what was committed before it started, never the preview.
   */
  const projectRef = useRef(project)
  useEffect(() => {
    projectRef.current = project
  }, [project])

  // A drag ends with a mouseup that the track would otherwise read as a click.
  const swallowNextSeekRef = useRef(false)

  const displayProject = previewProject ?? project

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const player = createPlayer(canvas, {
      onTime: setCurrentMicros,
      onPlayingChange: setPlaying,
      onExportProgress: (progress) =>
        setExportPercent(progress === null ? null : Math.round(progress * 100)),
      onExported: (buffer) => {
        const url = URL.createObjectURL(
          new Blob([buffer], { type: 'video/mp4' }),
        )
        const link = document.createElement('a')
        link.href = url
        link.download = exportFileName(exportNameRef.current)
        link.click()

        // Revoking immediately can cancel the download in some browsers.
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
      },
      onError: setError,
    })
    playerRef.current = player

    return () => {
      player.destroy()
      playerRef.current = null
    }
  }, [])

  // Latest values for the effect and the window handlers below, which are
  // bound once and so cannot close over current state.
  const playingRef = useRef(playing)
  const currentMicrosRef = useRef(currentMicros)
  useEffect(() => {
    playingRef.current = playing
    currentMicrosRef.current = currentMicros
  }, [playing, currentMicros])

  /** Where a gesture in progress wants the preview parked. */
  const previewTargetRef = useRef<number | null>(null)

  // The window mouse handlers are bound once, so they read the zoom from here.
  const zoomRef = useRef(pixelsPerSecond)
  useEffect(() => {
    zoomRef.current = pixelsPerSecond
  }, [pixelsPerSecond])

  /**
   * The worker renders whatever the project says, so any change republishes
   * it - and then re-renders the current position, because the same moment on
   * the timeline can show something different after a load, an edit or an undo.
   * Without the seek nothing appears until the user happens to click.
   */
  useEffect(() => {
    const player = playerRef.current
    if (!player) return

    player.setProject(displayProject)
    if (playingRef.current) return

    const timelineEnd = timelineDuration(displayProject)
    if (timelineEnd === 0) return

    const target = previewTargetRef.current ?? currentMicrosRef.current
    player.seek(Math.min(Math.max(0, target), timelineEnd - 1))
  }, [displayProject])

  const seek = useCallback((timelineMicros: number) => {
    playerRef.current?.seek(timelineMicros)
  }, [])

  /**
   * A seek the user asked for. The playhead moves at once rather than waiting
   * for the frame to come back, so a shortcut pressed straight after a click
   * acts on where the user just put the playhead.
   */
  const seekFromUser = useCallback(
    (timelineMicros: number) => {
      setCurrentMicros(timelineMicros)
      seek(timelineMicros)
    },
    [seek],
  )

  /** Grabs the playhead head, to scrub. */
  const handlePlayheadGrab = useCallback(
    (clientX: number) => {
      scrubRef.current = {
        startClientX: clientX,
        startMicros: currentMicrosRef.current,
      }
    },
    [],
  )

  /** Starts a gesture. Preview updates happen on mousemove, below. */
  const handleSegmentGrab = useCallback(
    (segmentId: string, mode: DragMode, clientX: number, trackId: string) => {
      dragRef.current = {
        segmentId,
        mode,
        startClientX: clientX,
        moved: false,
        trackId,
      }
    },
    [],
  )

  useEffect(() => {
    function onMouseMove(event: globalThis.MouseEvent) {
      const scrub = scrubRef.current
      if (scrub) {
        // Measured as a delta from where the head was grabbed, like every
        // other gesture, so it survives the strip being scrolled mid-drag.
        const micros = clampToTimeline(
          scrub.startMicros +
            pixelsToMicros(event.clientX - scrub.startClientX, zoomRef.current),
          timelineDuration(projectRef.current),
        )
        if (micros !== currentMicrosRef.current) {
          currentMicrosRef.current = micros
          setCurrentMicros(micros)
          playerRef.current?.seek(micros)
        }
        return
      }

      const drag = dragRef.current
      if (!drag) return

      const deltaMicros = pixelsToMicros(
        event.clientX - drag.startClientX,
        zoomRef.current,
      )
      if (deltaMicros === 0 && !drag.moved) return
      drag.moved = true

      // Which row the pointer is over, so a segment can be dragged between
      // them. A trim stays on its own row whatever the pointer is over.
      const overTrackId =
        drag.mode === 'move'
          ? trackIdAtPoint(event.clientX, event.clientY)
          : undefined

      const gesture: SegmentDrag = {
        segmentId: drag.segmentId,
        mode: drag.mode,
        deltaMicros,
        ...(overTrackId ? { trackId: overTrackId } : {}),
      }
      const preview = applyDrag(projectRef.current, gesture)
      previewTargetRef.current = dragPreviewMicros(preview, gesture)
      setPreviewProject(preview)
    }

    function onMouseUp(event: globalThis.MouseEvent) {
      if (scrubRef.current) {
        scrubRef.current = null
        // The mouseup would otherwise reach the track as a click and seek back.
        swallowNextSeekRef.current = true
        return
      }

      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null

      // Where the gesture left the preview. The playhead moves there for real
      // rather than snapping back to wherever it was before the drag: trimming
      // a head forward leaves the old position in a gap, and the preview would
      // go black for an edit that was meant to be shown.
      const landedAt = previewTargetRef.current
      previewTargetRef.current = null
      setPreviewProject(null)

      if (landedAt !== null && drag.moved) {
        currentMicrosRef.current = landedAt
        setCurrentMicros(landedAt)
      }

      if (!drag.moved) return
      swallowNextSeekRef.current = true

      // One operation, so one undo step, no matter how many mousemoves it took.
      const overTrackId =
        drag.mode === 'move'
          ? trackIdAtPoint(event.clientX, event.clientY)
          : undefined

      const gesture: SegmentDrag = {
        segmentId: drag.segmentId,
        mode: drag.mode,
        deltaMicros: pixelsToMicros(
          event.clientX - drag.startClientX,
          zoomRef.current,
        ),
        ...(overTrackId ? { trackId: overTrackId } : {}),
      }
      const operation = dragToOperation(projectRef.current, gesture)
      if (!operation) return

      const store = useTimelineStore.getState()
      try {
        switch (operation.kind) {
          case 'move':
            store.moveSegment(operation.input)
            break
          case 'trim-start':
            store.trimSegmentStart(operation.input)
            break
          case 'trim-end':
            store.trimSegmentEnd(operation.input)
            break
        }
      } catch (err) {
        // An illegal drop snaps back rather than surfacing as a failure.
        console.warn('[timeline] drag discarded:', err)
      }
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

      const store = useTimelineStore.getState()

      if (event.ctrlKey || event.metaKey) {
        const key = event.key.toLowerCase()
        if (key === 'z' && !event.shiftKey) {
          event.preventDefault()
          store.undo()
          return
        }
        if (key === 'y' || (key === 'z' && event.shiftKey)) {
          event.preventDefault()
          store.redo()
          return
        }
        return
      }

      if (event.key.toLowerCase() === 's') {
        event.preventDefault()
        store.splitSegmentAt({
          timelineMicros: currentMicros,
          newSegmentId: crypto.randomUUID(),
        })
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentMicros])

  /**
   * Edits one transform field.
   *
   * On a property that is already animated this writes a keyframe at the
   * playhead rather than the fixed value: once there is a curve, the fixed
   * value is not what is being shown, so changing it would look like nothing
   * happened. That is also what makes dragging a value at successive
   * positions build an animation, which is how it works in every editor.
   */
  function setTransformValue(property: AnimatableProperty, value: number) {
    const store = useTimelineStore.getState()
    const segment = selectedSegmentId
      ? findSegment(store.project, selectedSegmentId)?.segment
      : undefined
    if (!segment || !selectedSegmentId || !Number.isFinite(value)) return

    if (isPropertyAnimated(segment, property)) {
      store.addKeyframe({
        segmentId: selectedSegmentId,
        property,
        offsetMicros: offsetIn(segment, currentMicros),
        value,
      })
      return
    }

    store.setSegmentProperties({
      segmentId: selectedSegmentId,
      [property]: value,
    })
  }

  /**
   * One editable property: its value now, and the keyframe button for it.
   *
   * Shared by the transform panel and the audio panel, because a volume fade
   * and an opacity fade are the same interaction on the same machinery - the
   * only difference is which list the field came from.
   */
  function propertyField(field: PropertyField) {
    if (!selectedSegment || !selectedSegmentId) return null

    const offsetMicros = offsetIn(selectedSegment, currentMicros)
    const animated = isPropertyAnimated(selectedSegment, field.property)
    const keyed = hasKeyframeAt(selectedSegment, field.property, offsetMicros)
    const value = propertyAt(selectedSegment, field.property, currentMicros)

    return (
      <label key={field.property} className="transform-field">
        <span className="transform-label">{field.label}</span>
        <input
          type="number"
          step={field.step}
          min={field.min}
          max={field.max}
          data-testid={`transform-${field.property}`}
          value={Math.round(value * 1000) / 1000}
          onBlur={() => useTimelineStore.getState().endCoalescing()}
          onChange={(event) =>
            setTransformValue(field.property, Number(event.target.value))
          }
        />
        <button
          type="button"
          className={
            keyed
              ? 'keyframe-toggle is-keyed'
              : animated
                ? 'keyframe-toggle is-animated'
                : 'keyframe-toggle'
          }
          title={
            keyed
              ? 'Remove the keyframe at the playhead'
              : 'Add a keyframe at the playhead'
          }
          data-testid={`keyframe-${field.property}`}
          data-keyed={keyed ? 'true' : 'false'}
          onClick={() => toggleKeyframe(field.property)}
        >
          {keyed ? '\u25c6' : '\u25c7'}
        </button>
      </label>
    )
  }

  /** Puts a keyframe at the playhead, or takes the one there away. */
  function toggleKeyframe(property: AnimatableProperty) {
    const store = useTimelineStore.getState()
    const segment = selectedSegmentId
      ? findSegment(store.project, selectedSegmentId)?.segment
      : undefined
    if (!segment || !selectedSegmentId) return

    const offsetMicros = offsetIn(segment, currentMicros)

    if (hasKeyframeAt(segment, property, offsetMicros)) {
      store.removeKeyframe({ segmentId: selectedSegmentId, property, offsetMicros })
      return
    }

    // The first keyframe holds whatever is on screen right now, so pressing
    // the button never changes the picture - it only starts pinning it.
    store.addKeyframe({
      segmentId: selectedSegmentId,
      property,
      offsetMicros,
      value: propertyAt(segment, property, currentMicros),
    })
  }

  /** Adds a row of a kind on top of the stack. */
  function addTrack(kind: TrackKind) {
    useTimelineStore.getState().addTrack({
      id: `${kind}-${crypto.randomUUID().slice(0, 8)}`,
      kind,
    })
  }

  /**
   * Removes a row and everything on it.
   *
   * The last row of a kind can go too: there is nothing special about it, and
   * adding one back is a button away.
   */
  function removeTrack(trackId: string) {
    const store = useTimelineStore.getState()
    const doomed = store.project.tracks.find((track) => track.id === trackId)
    if (doomed?.segments.some((segment) => segment.id === selectedSegmentId)) {
      setSelectedSegmentId(null)
    }
    store.removeTrack(trackId)
  }

  /** Writes the timeline out as a draft file. */
  function saveDraft() {
    const project = useTimelineStore.getState().project
    const url = URL.createObjectURL(
      new Blob([serializeDraft(project)], { type: 'application/json' }),
    )

    const link = document.createElement('a')
    link.href = url
    link.download = draftFileName(project)
    link.click()

    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  /** Reads a draft file back in, leaving its media to be relinked. */
  async function openDraft(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setError(null)
    setExportPercent(null)

    try {
      const project = parseDraftText(await file.text())

      // A draft carries no media, so nothing that was open still applies.
      clearSourceFiles()
      useTimelineStore.getState().openProject(project)
      setSelectedSegmentId(null)
      setCurrentMicros(0)
      setRelinkTick((tick) => tick + 1)
      exportNameRef.current =
        Object.values(project.sources)[0]?.name ?? 'timeline'
    } catch (err) {
      // A draft that cannot be read says why; anything else is a real fault.
      setError(
        isDraftError(err)
          ? (err as Error).message
          : err instanceof Error
            ? err.message
            : String(err),
      )
    }
  }

  /** Hands a file back to a source the draft could only name. */
  async function relinkSource(
    sourceId: string,
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setError(null)
    const store = useTimelineStore.getState()
    const known = store.project.sources[sourceId]
    if (!known) return

    try {
      const geometry = await playerRef.current!.probeSource(sourceId, file)
      const needed = furthestIntoSource(store.project, sourceId)

      if (geometry.durationMicros < needed) {
        setError(
          `${file.name} is too short for this timeline: it needs` +
            ` ${formatMicros(needed)} of ${known.name} but this file is` +
            ` ${formatMicros(geometry.durationMicros)}.`,
        )
        return
      }

      registerSourceFile(sourceId, file)

      // The real file decides the geometry from here: it is what gets decoded.
      store.addSource({
        id: sourceId,
        name: file.name,
        durationMicros: geometry.durationMicros,
        width: geometry.width,
        height: geometry.height,
        rotation: geometry.rotation,
      })
      setRelinkTick((tick) => tick + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** Puts a new effect on the selected segment, at its neutral amount. */
  function addEffect(kind: EffectKind) {
    if (!selectedSegmentId) return
    useTimelineStore.getState().addEffect({
      segmentId: selectedSegmentId,
      id: crypto.randomUUID(),
      kind,
    })
  }

  /** Drops a new text segment at the playhead, centred in the composition. */
  function addOverlayAtPlayhead() {
    const store = useTimelineStore.getState()
    const { width, height } = store.project.composition
    const trackId = firstTrackId(store.project, 'text')
    if (!trackId) return

    const id = crypto.randomUUID()
    store.addSegment({
      trackId,
      segment: {
        id,
        timelineStartMicros: currentMicros,
        content: {
          kind: 'text',
          content: overlayText || 'Text',
          x: Math.round(width * 0.1),
          y: Math.round(height * 0.45),
          sizePx: Math.max(12, Math.round(height * 0.12)),
          color: '#ffffff',
          durationMicros: NEW_OVERLAY_MICROS,
        },
      },
    })
    setSelectedSegmentId(id)
  }

  /**
   * Appends a segment covering the whole of a source, after everything already
   * on its own row.
   *
   * Which row that is follows from the file: something with a picture goes on
   * a video row, something with only sound goes on an audio row. Text on a row
   * of its own does not push either of them along.
   */
  function appendClip(sourceId: string) {
    const store = useTimelineStore.getState()
    const source = store.project.sources[sourceId]
    if (!source) return

    const kind: TrackKind = sourceHasVideo(source) ? 'video' : 'audio'
    const trackId = firstTrackId(store.project, kind)
    if (!trackId) {
      setError(`This project has no ${kind} row to put ${source.name} on.`)
      return
    }

    store.addSegment({
      trackId,
      segment: {
        id: crypto.randomUUID(),
        timelineStartMicros: trackEndMicros(store.project, trackId),
        content: {
          kind,
          sourceId,
          sourceInMicros: 0,
          sourceOutMicros: source.durationMicros,
        },
      },
    })
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // Cleared so that picking the same file twice still fires a change.
    event.target.value = ''
    if (!file) return

    setError(null)
    setExportPercent(null)

    const store = useTimelineStore.getState()
    const isFirstSource = Object.keys(store.project.sources).length === 0
    if (isFirstSource) exportNameRef.current = file.name

    /** Whether any file opened so far had a picture to size the project by. */
    const hadVideo = Object.values(store.project.sources).some(sourceHasVideo)

    const sourceId = crypto.randomUUID()
    registerSourceFile(sourceId, file)

    try {
      const geometry = await playerRef.current!.probeSource(sourceId, file)

      // The composition defaults to the first source WITH A PICTURE and is
      // then the user's; later files letterbox into it rather than redefining
      // it. A piece of music has no shape to offer, so it never sets one.
      if (!hadVideo && geometry.hasVideo) {
        store.setComposition({ width: geometry.width, height: geometry.height })
      }

      store.addSource({
        id: sourceId,
        name: file.name,
        durationMicros: geometry.durationMicros,
        width: geometry.width,
        height: geometry.height,
        rotation: geometry.rotation,
      })
      appendClip(sourceId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const duration = timelineDuration(displayProject)
  const hasTimeline = duration > 0
  const exportSettings = exportSettingsOf(displayProject)
  const exportSize = exportDimensions(
    displayProject.composition,
    exportSettings,
  )
  const sources = Object.values(displayProject.sources)
  // The source registry is deliberately not store state, so nothing would tell
  // React that a source stopped being offline. relinkTick is that signal.
  const offlineSources = useMemo(
    () => sources.filter((source) => !hasSourceFile(source.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sources, relinkTick],
  )
  const selectedSegment = selectedSegmentId
    ? findSegment(displayProject, selectedSegmentId)?.segment
    : undefined
  // Only text has anything to edit in the panel; a video segment is selected
  // for dragging and cutting, not for styling.
  const selectedText = selectedSegment
    ? textContent(selectedSegment)
    : undefined
  /** A segment nobody looks at has no transform worth showing. */
  const selectedDraws = selectedSegment?.content.kind !== 'audio'
  /** A segment nobody hears has no volume worth showing. */
  const selectedHasSound = selectedSegment
    ? soundContent(selectedSegment) !== undefined
    : false

  /**
   * Whether the selection has a cut before it worth blending across: it must
   * be on a packed row, with something immediately before it.
   */
  const selectedTrack =
    selectedSegmentId && selectedSegment
      ? trackOf(displayProject, selectedSegmentId)
      : undefined
  const selectedIndex = selectedTrack && selectedSegment
    ? selectedTrack.segments.indexOf(selectedSegment)
    : -1
  const canTransition =
    selectedTrack !== undefined &&
    selectedTrack.kind !== 'text' &&
    selectedIndex > 0

  /** Zooms so the whole timeline fits the visible strip. */
  function fitZoom() {
    const strip = document.querySelector('[data-testid=timeline-scroll]')
    const available = strip?.clientWidth ?? window.innerWidth
    setPixelsPerSecond(fitPixelsPerSecond(duration, available))
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="wordmark">Video Editor</h1>

        <div className="transport">
        <button
          type="button"
          onClick={() => playerRef.current?.play()}
          disabled={!hasTimeline || playing || exportPercent !== null}
        >
          Play
        </button>{' '}
        <button
          type="button"
          onClick={() => playerRef.current?.pause()}
          disabled={!playing}
        >
          Pause
        </button>{' '}
        <button
          type="button"
          onClick={() => playerRef.current?.exportMp4()}
          disabled={!hasTimeline || exportPercent !== null}
        >
          Export
        </button>{' '}
        <span data-testid="time">
          {formatMicros(currentMicros)} / {formatMicros(duration)}
        </span>
        </div>

        <div className="zoom-controls">
        <button
          type="button"
          data-testid="zoom-out"
          onClick={() => setPixelsPerSecond((zoom) => clampZoom(zoom / ZOOM_STEP))}
        >
          -
        </button>{' '}
        <button
          type="button"
          data-testid="zoom-in"
          onClick={() => setPixelsPerSecond((zoom) => clampZoom(zoom * ZOOM_STEP))}
        >
          +
        </button>{' '}
        <button type="button" data-testid="zoom-fit" onClick={fitZoom}>
          Fit
        </button>{' '}
        <span data-testid="zoom">{Math.round(pixelsPerSecond)} px/s</span>
        </div>

        <div className="draft-controls">
          <button type="button" data-testid="save-draft" onClick={saveDraft}>
            Save
          </button>{' '}
          <label className="open-draft">
            Open
            <input
              type="file"
              accept="application/json,.json"
              data-testid="open-draft"
              onChange={openDraft}
            />
          </label>
        </div>
      </header>

      <aside className="sidebar">
        <section className="panel">
          <h2 className="panel-title">Media</h2>
          <input
            type="file"
            accept="video/*"
            data-testid="media-input"
            onChange={handleFileChange}
            className="file-input"
          />
      {sources.length > 0 && (
        <ul className="media-list" data-testid="media-list">
          {sources.map((source) => (
            <li key={source.id} data-testid="media-item">
              <span data-testid="media-name">{source.name}</span>{' '}
              <span className="media-meta">
                {sourceHasVideo(source)
                  ? `${source.width} x ${source.height}`
                  : 'audio only'}
              </span>{' '}
              <button
                type="button"
                data-testid="add-to-timeline"
                data-source-id={source.id}
                onClick={() => appendClip(source.id)}
              >
                Add to timeline
              </button>
            </li>
          ))}
        </ul>
      )}

        </section>

        {offlineSources.length > 0 && (
          <section className="panel" data-testid="offline-panel">
            <h2 className="panel-title">Media to relink</h2>
            <p className="panel-note">
              A draft remembers what it used, not the files themselves. Point
              each one at its file to bring the timeline back.
            </p>
            <ul className="media-list" data-testid="offline-list">
              {offlineSources.map((source) => (
                <li key={source.id} data-testid="offline-item">
                  <span data-testid="offline-name">{source.name}</span>{' '}
                  <span className="media-meta">
                    {formatMicros(source.durationMicros)}
                  </span>
                  <input
                    type="file"
                    accept="video/*"
                    className="file-input"
                    data-testid="relink-input"
                    data-source-id={source.id}
                    onChange={(event) => relinkSource(source.id, event)}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="panel" data-testid="export-panel">
          <h2 className="panel-title">Export</h2>
          <div className="export-form">
            <label>
              <span>size</span>
              <select
                data-testid="export-height"
                value={exportSettings.heightPx === null
                  ? 'source'
                  : String(exportSettings.heightPx)}
                onChange={(event) =>
                  useTimelineStore.getState().setExportSettings({
                    heightPx:
                      event.target.value === 'source'
                        ? null
                        : Number(event.target.value),
                  })
                }
              >
                <option value="source">
                  Same as composition ({displayProject.composition.width}x
                  {displayProject.composition.height})
                </option>
                {EXPORT_HEIGHTS.map((height) => (
                  <option key={height} value={height}>
                    {height}p
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>quality</span>
              <select
                data-testid="export-quality"
                value={exportSettings.quality}
                onChange={(event) =>
                  useTimelineStore.getState().setExportSettings({
                    quality: event.target
                      .value as (typeof EXPORT_QUALITIES)[number],
                  })
                }
              >
                {EXPORT_QUALITIES.map((quality) => (
                  <option key={quality} value={quality}>
                    {QUALITY_LABELS[quality] ?? quality}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="panel-note" data-testid="export-summary">
            Writes {exportSize.width}x{exportSize.height} MP4.
            {exportSize.height > displayProject.composition.height
              ? ' Larger than the composition, so it is scaled up.'
              : ''}
          </p>
        </section>

        <section className="panel">
          <h2 className="panel-title">Rows</h2>
          <div className="track-buttons">
            <button
              type="button"
              data-testid="add-video-track"
              onClick={() => addTrack('video')}
            >
              + video row
            </button>{' '}
            <button
              type="button"
              data-testid="add-text-track"
              onClick={() => addTrack('text')}
            >
              + text row
            </button>{' '}
            <button
              type="button"
              data-testid="add-audio-track"
              onClick={() => addTrack('audio')}
            >
              + audio row
            </button>
          </div>
          <ul className="track-list" data-testid="track-list">
            {[...displayProject.tracks].reverse().map((track) => (
              <li
                key={track.id}
                className="track-row"
                data-testid="track-item"
                data-track-id={track.id}
                data-track-kind={track.kind}
              >
                <span className="track-name">{track.kind}</span>
                <span className="media-meta">
                  {track.segments.length}
                  {track.segments.length === 1 ? ' item' : ' items'}
                </span>
                <button
                  type="button"
                  className="effect-remove"
                  title="Remove this row and everything on it"
                  data-testid="remove-track"
                  data-track-id={track.id}
                  onClick={() => removeTrack(track.id)}
                >
                  &times;
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2 className="panel-title">Text</h2>
      <div className="overlay-form">
        <input
          type="text"
          value={overlayText}
          data-testid="overlay-text"
          onBlur={() => useTimelineStore.getState().endCoalescing()}
          onChange={(event) => {
            setOverlayText(event.target.value)
            if (selectedText && selectedSegmentId) {
              useTimelineStore.getState().setTextStyle({
                segmentId: selectedSegmentId,
                content: event.target.value,
              })
            }
          }}
        />{' '}
        <button
          type="button"
          data-testid="add-overlay"
          onClick={addOverlayAtPlayhead}
          disabled={!hasTimeline}
        >
          Add text
        </button>
        {selectedText && selectedSegmentId && (
          <>
            {' '}
            <label>
              x{' '}
              <input
                type="number"
                data-testid="overlay-x"
                onBlur={() => useTimelineStore.getState().endCoalescing()}
                value={selectedText.x}
                onChange={(event) =>
                  useTimelineStore.getState().setTextStyle({
                    segmentId: selectedSegmentId,
                    x: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              y{' '}
              <input
                type="number"
                data-testid="overlay-y"
                onBlur={() => useTimelineStore.getState().endCoalescing()}
                value={selectedText.y}
                onChange={(event) =>
                  useTimelineStore.getState().setTextStyle({
                    segmentId: selectedSegmentId,
                    y: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              size{' '}
              <input
                type="number"
                data-testid="overlay-size"
                onBlur={() => useTimelineStore.getState().endCoalescing()}
                value={selectedText.sizePx}
                onChange={(event) =>
                  useTimelineStore.getState().setTextStyle({
                    segmentId: selectedSegmentId,
                    sizePx: Math.max(1, Number(event.target.value)),
                  })
                }
              />
            </label>
            <label>
              colour{' '}
              <input
                type="color"
                data-testid="overlay-color"
                onBlur={() => useTimelineStore.getState().endCoalescing()}
                value={selectedText.color}
                onChange={(event) =>
                  useTimelineStore.getState().setTextStyle({
                    segmentId: selectedSegmentId,
                    color: event.target.value,
                  })
                }
              />
            </label>{' '}
            <button
              type="button"
              data-testid="remove-overlay"
              onClick={() => {
                useTimelineStore.getState().removeSegment(selectedSegmentId)
                setSelectedSegmentId(null)
              }}
            >
              Remove
            </button>
          </>
        )}
      </div>

        </section>

        {selectedSegment && selectedSegmentId && selectedDraws && (
          <section className="panel" data-testid="transform-panel">
            <h2 className="panel-title">Transform</h2>
            <div className="transform-form">
              {TRANSFORM_FIELDS.map(propertyField)}
            </div>
          </section>
        )}

        {selectedSegment && selectedSegmentId && selectedHasSound && (
          <section className="panel" data-testid="speed-panel">
            <h2 className="panel-title">Speed</h2>
            <div className="track-buttons">
              {RATE_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={
                    segmentRate(selectedSegment) === preset
                      ? 'rate-preset is-current'
                      : 'rate-preset'
                  }
                  data-testid={`rate-${preset}`}
                  onClick={() => {
                    try {
                      useTimelineStore
                        .getState()
                        .setSegmentRate({
                          segmentId: selectedSegmentId,
                          rate: preset,
                        })
                      setError(null)
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err))
                    }
                  }}
                >
                  {preset}x
                </button>
              ))}
            </div>
            <p className="panel-note" data-testid="speed-summary">
              {formatMicros(segmentDuration(selectedSegment))} on the timeline
              {segmentRate(selectedSegment) !== 1
                ? '. Sound is pitched by the same amount, as speeding up a tape would.'
                : '.'}
            </p>
          </section>
        )}

        {selectedSegment && selectedSegmentId && canTransition && (
          <section className="panel" data-testid="transition-panel">
            <h2 className="panel-title">Transition in</h2>
            <div className="transform-form">
              <label className="transform-field">
                <span className="transform-label">blend</span>
                <select
                  data-testid="transition-kind"
                  value={selectedSegment.transitionIn?.kind ?? 'none'}
                  onChange={(event) => {
                    const store = useTimelineStore.getState()
                    if (event.target.value === 'none') {
                      store.removeTransition(selectedSegmentId)
                      return
                    }
                    store.setTransition({
                      segmentId: selectedSegmentId,
                      kind: event.target.value as TransitionKind,
                      durationMicros:
                        selectedSegment.transitionIn?.durationMicros ??
                        DEFAULT_TRANSITION_MICROS,
                    })
                  }}
                >
                  <option value="none">none</option>
                  {TRANSITION_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
                <span />
              </label>

              {selectedSegment.transitionIn && (
                <label className="transform-field">
                  <span className="transform-label">seconds</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0.1}
                    data-testid="transition-seconds"
                    value={
                      Math.round(
                        (selectedSegment.transitionIn.durationMicros / 1e6) *
                          100,
                      ) / 100
                    }
                    onBlur={() => useTimelineStore.getState().endCoalescing()}
                    onChange={(event) => {
                      const seconds = Number(event.target.value)
                      if (!Number.isFinite(seconds) || seconds <= 0) return

                      useTimelineStore.getState().setTransition({
                        segmentId: selectedSegmentId,
                        kind: selectedSegment.transitionIn!.kind,
                        durationMicros: Math.round(seconds * 1e6),
                      })
                    }}
                  />
                  <span />
                </label>
              )}
            </div>
            <p className="panel-note">
              A blend costs time: the clip and everything after it move earlier
              by its length, so the project gets that much shorter.
            </p>
          </section>
        )}

        {selectedSegment && selectedSegmentId && selectedHasSound && (
          <section className="panel" data-testid="levels-panel">
            <h2 className="panel-title">Audio</h2>
            <div className="transform-form">{LEVEL_FIELDS.map(propertyField)}</div>
            <p className="panel-note">
              1 is the clip as recorded, 0 is silent. Keyframe it to fade.
            </p>
          </section>
        )}

        {selectedSegment && selectedSegmentId && selectedDraws && (
          <section className="panel" data-testid="compositing-panel">
            <h2 className="panel-title">Compositing</h2>

            <div className="transform-form">
              <label className="transform-field">
                <span className="transform-label">blend</span>
                <select
                  data-testid="blend-mode"
                  value={selectedSegment.blendMode ?? 'normal'}
                  onChange={(event) =>
                    useTimelineStore.getState().setSegmentBlendMode({
                      segmentId: selectedSegmentId,
                      blendMode: event.target.value as BlendMode,
                    })
                  }
                >
                  {BLEND_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
                <span />
              </label>

              <label className="transform-field">
                <span className="transform-label">mask</span>
                <select
                  data-testid="mask-shape"
                  value={selectedSegment.mask?.shape ?? 'none'}
                  onChange={(event) => {
                    const store = useTimelineStore.getState()
                    if (event.target.value === 'none') {
                      store.removeSegmentMask(selectedSegmentId)
                      return
                    }
                    store.setSegmentMask({
                      segmentId: selectedSegmentId,
                      shape: event.target.value as MaskShape,
                    })
                  }}
                >
                  <option value="none">none</option>
                  {MASK_SHAPES.map((shape) => (
                    <option key={shape} value={shape}>
                      {shape}
                    </option>
                  ))}
                </select>
                <span />
              </label>

              {selectedSegment.mask &&
                (
                  [
                    ['x', 'centre x', 1],
                    ['y', 'centre y', 1],
                    ['width', 'width', 1],
                    ['height', 'height', 1],
                    ['featherPx', 'feather', 1],
                  ] as const
                ).map(([field, label, step]) => (
                  <label key={field} className="transform-field">
                    <span className="transform-label">{label}</span>
                    <input
                      type="number"
                      step={step}
                      data-testid={`mask-${field}`}
                      value={selectedSegment.mask![field]}
                      onBlur={() => useTimelineStore.getState().endCoalescing()}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        if (!Number.isFinite(value)) return
                        try {
                          useTimelineStore.getState().setSegmentMask({
                            segmentId: selectedSegmentId,
                            [field]: value,
                          })
                          setError(null)
                        } catch (err) {
                          setError(
                            err instanceof Error ? err.message : String(err),
                          )
                        }
                      }}
                    />
                    <span />
                  </label>
                ))}

              {selectedSegment.mask && (
                <label className="transform-field">
                  <span className="transform-label">invert</span>
                  <input
                    type="checkbox"
                    data-testid="mask-inverted"
                    checked={selectedSegment.mask.inverted}
                    onChange={(event) =>
                      useTimelineStore.getState().setSegmentMask({
                        segmentId: selectedSegmentId,
                        inverted: event.target.checked,
                      })
                    }
                  />
                  <span />
                </label>
              )}
            </div>

            <p className="panel-note">
              A blend mode reads what is underneath, so a row below is drawn
              even where this one covers it.
            </p>
          </section>
        )}

        {selectedSegment && selectedSegmentId && (
          <section className="panel" data-testid="effects-panel">
            <h2 className="panel-title">Effects</h2>

            <select
              className="effect-picker"
              data-testid="add-effect"
              value=""
              onChange={(event) => {
                if (!event.target.value) return
                addEffect(event.target.value as EffectKind)
                event.target.value = ''
              }}
            >
              <option value="">Add an effect...</option>
              {EFFECT_KIND_NAMES.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>

            <ul className="effect-list" data-testid="effect-list">
              {(selectedSegment.effects ?? []).map((effect) => {
                const spec = EFFECT_KINDS[effect.kind]
                const offsetMicros = offsetIn(selectedSegment, currentMicros)

                return (
                  <li
                    key={effect.id}
                    className="effect-row"
                    data-testid="effect-row"
                    data-effect-kind={effect.kind}
                  >
                    <span className="effect-name">{effect.kind}</span>
                    <input
                      type="number"
                      step={spec.step}
                      min={spec.min}
                      max={spec.max}
                      data-testid={`effect-amount-${effect.kind}`}
                      value={
                        Math.round(effectAmountAt(effect, offsetMicros) * 1000) /
                        1000
                      }
                      onBlur={() => useTimelineStore.getState().endCoalescing()}
                      onChange={(event) => {
                        const store = useTimelineStore.getState()
                        const amount = Number(event.target.value)
                        if (!Number.isFinite(amount)) return

                        // Same rule as a transform: once it has a curve, an
                        // edit writes a keyframe rather than the fixed value.
                        if ((effect.keyframes?.length ?? 0) > 0) {
                          store.addEffectKeyframe({
                            segmentId: selectedSegmentId,
                            effectId: effect.id,
                            offsetMicros,
                            value: amount,
                          })
                        } else {
                          store.setEffectAmount({
                            segmentId: selectedSegmentId,
                            effectId: effect.id,
                            amount,
                          })
                        }
                      }}
                    />
                    <button
                      type="button"
                      className={
                        (effect.keyframes ?? []).some(
                          (k) => k.offsetMicros === offsetMicros,
                        )
                          ? 'keyframe-toggle is-keyed'
                          : (effect.keyframes?.length ?? 0) > 0
                            ? 'keyframe-toggle is-animated'
                            : 'keyframe-toggle'
                      }
                      title="Keyframe this effect at the playhead"
                      data-testid={`effect-keyframe-${effect.kind}`}
                      onClick={() => {
                        const store = useTimelineStore.getState()
                        const keyed = (effect.keyframes ?? []).some(
                          (k) => k.offsetMicros === offsetMicros,
                        )
                        if (keyed) {
                          store.removeEffectKeyframe({
                            segmentId: selectedSegmentId,
                            effectId: effect.id,
                            offsetMicros,
                          })
                        } else {
                          store.addEffectKeyframe({
                            segmentId: selectedSegmentId,
                            effectId: effect.id,
                            offsetMicros,
                            value: effectAmountAt(effect, offsetMicros),
                          })
                        }
                      }}
                    >
                      {(effect.keyframes ?? []).some(
                        (k) => k.offsetMicros === offsetMicros,
                      )
                        ? '\u25c6'
                        : '\u25c7'}
                    </button>
                    <button
                      type="button"
                      className="effect-remove"
                      data-testid={`remove-effect-${effect.kind}`}
                      title="Remove this effect"
                      onClick={() =>
                        useTimelineStore.getState().removeEffect({
                          segmentId: selectedSegmentId,
                          effectId: effect.id,
                        })
                      }
                    >
                      &times;
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        <section className="panel shortcuts">
          <h2 className="panel-title">Shortcuts</h2>
          <dl>
            <dt>S</dt>
            <dd>split at the playhead</dd>
            <dt>Ctrl+Z</dt>
            <dd>undo</dd>
            <dt>Ctrl+Y</dt>
            <dd>redo</dd>
            <dt>Ctrl+scroll</dt>
            <dd>zoom the timeline</dd>
            <dt>drag</dt>
            <dd>move a segment, or drop it on another row; drag an edge to trim</dd>
            <dt>&#9671;</dt>
            <dd>keyframe the value at the playhead</dd>
            <dt>Save</dt>
            <dd>write the timeline out as a draft</dd>
          </dl>
        </section>
      </aside>

      <main className="stage">
        <div className="stage-status">
          {exportPercent !== null && (
            <p className="status status-busy">Exporting: {exportPercent}%</p>
          )}
          {error !== null && <p className="status status-error">Error: {error}</p>}
          {hasTimeline && (
            <p className="status">
              Composition {displayProject.composition.width} x{' '}
              {displayProject.composition.height}
            </p>
          )}
        </div>

        <div className="stage-canvas">
          <canvas ref={canvasRef} />
        </div>
      </main>

      <footer className="dock">
        <Timeline
          project={displayProject}
          currentMicros={currentMicros}
          onSeek={(micros) => {
            if (swallowNextSeekRef.current) {
              swallowNextSeekRef.current = false
              return
            }
            seekFromUser(micros)
          }}
          onSegmentGrab={handleSegmentGrab}
          pixelsPerSecond={pixelsPerSecond}
          onZoom={setPixelsPerSecond}
          selectedId={selectedSegmentId}
          onSelect={setSelectedSegmentId}
          onPlayheadGrab={handlePlayheadGrab}
        />
      </footer>
    </div>
  )
}
