import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { createPlayer } from './player'
import { exportFileName, formatMicros } from './playback'
import {
  applyDrag,
  dragPreviewMicros,
  dragToOperation,
  findOverlay,
  type ClipDrag,
  type DragMode,
  type DragTarget,
} from './timeline/dragging'
import {
  DEFAULT_PIXELS_PER_SECOND,
  ZOOM_STEP,
  clampZoom,
  fitPixelsPerSecond,
  pixelsToMicros,
} from './timeline/layout'
import { timelineDuration } from './timeline/operations'
import { registerSourceFile } from './timeline/sourceRegistry'
import { useTimelineStore } from './timeline/store'
import type { Project } from './timeline/types'
import Timeline from './ui/Timeline'

/** A gesture in progress. Nothing here has reached the undo history yet. */
type ActiveDrag = {
  clipId: string
  mode: DragMode
  startClientX: number
  moved: boolean
  target: DragTarget
}

/** A new overlay lands mid-composition, visible, and lasting two seconds. */
const NEW_OVERLAY_MICROS = 2_000_000

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
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(
    null,
  )
  const [overlayText, setOverlayText] = useState('Text')

  const dragRef = useRef<ActiveDrag | null>(null)
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

  /** Starts a gesture. Preview updates happen on mousemove, below. */
  const handleClipGrab = useCallback(
    (clipId: string, mode: DragMode, clientX: number, target: DragTarget) => {
      dragRef.current = {
        clipId,
        mode,
        startClientX: clientX,
        moved: false,
        target,
      }
    },
    [],
  )

  useEffect(() => {
    function onMouseMove(event: globalThis.MouseEvent) {
      const drag = dragRef.current
      if (!drag) return

      const deltaMicros = pixelsToMicros(
        event.clientX - drag.startClientX,
        zoomRef.current,
      )
      if (deltaMicros === 0 && !drag.moved) return
      drag.moved = true

      const gesture: ClipDrag = {
        clipId: drag.clipId,
        mode: drag.mode,
        deltaMicros,
        target: drag.target,
      }
      const preview = applyDrag(projectRef.current, gesture)
      previewTargetRef.current = dragPreviewMicros(preview, gesture)
      setPreviewProject(preview)
    }

    function onMouseUp(event: globalThis.MouseEvent) {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      previewTargetRef.current = null
      setPreviewProject(null)

      if (!drag.moved) return
      swallowNextSeekRef.current = true

      // One operation, so one undo step, no matter how many mousemoves it took.
      const gesture: ClipDrag = {
        clipId: drag.clipId,
        mode: drag.mode,
        deltaMicros: pixelsToMicros(
          event.clientX - drag.startClientX,
          zoomRef.current,
        ),
        target: drag.target,
      }
      const operation = dragToOperation(projectRef.current, gesture)
      if (!operation) return

      const store = useTimelineStore.getState()
      try {
        switch (operation.kind) {
          case 'move':
            store.moveClip(operation.input)
            break
          case 'trim-start':
            store.trimClipStart(operation.input)
            break
          case 'trim-end':
            store.trimClipEnd(operation.input)
            break
          case 'move-overlay':
            store.moveOverlay(operation.input)
            break
          case 'trim-overlay-start':
            store.trimOverlayStart(operation.input)
            break
          case 'trim-overlay-end':
            store.trimOverlayEnd(operation.input)
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
        store.splitClipAt({
          timelineMicros: currentMicros,
          newClipId: crypto.randomUUID(),
        })
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentMicros])

  /** Drops a new overlay at the playhead, centred in the composition. */
  function addOverlayAtPlayhead() {
    const store = useTimelineStore.getState()
    const { width, height } = store.project.composition
    const id = crypto.randomUUID()

    store.addOverlay({
      id,
      content: overlayText || 'Text',
      x: Math.round(width * 0.1),
      y: Math.round(height * 0.45),
      sizePx: Math.max(12, Math.round(height * 0.12)),
      color: '#ffffff',
      timelineStartMicros: currentMicros,
      durationMicros: NEW_OVERLAY_MICROS,
    })
    setSelectedOverlayId(id)
  }

  /** Appends a clip covering the whole of a source, after everything else. */
  function appendClip(sourceId: string) {
    const store = useTimelineStore.getState()
    const source = store.project.sources[sourceId]
    if (!source) return

    store.addClip({
      id: crypto.randomUUID(),
      sourceId,
      sourceInMicros: 0,
      sourceOutMicros: source.durationMicros,
      timelineStartMicros: timelineDuration(store.project),
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

    const sourceId = crypto.randomUUID()
    registerSourceFile(sourceId, file)

    try {
      const geometry = await playerRef.current!.probeSource(sourceId, file)

      // The composition defaults to the FIRST source and is then the user's;
      // later files letterbox into it rather than redefining it.
      if (isFirstSource) {
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
  const sources = Object.values(displayProject.sources)
  const selectedOverlay = selectedOverlayId
    ? findOverlay(displayProject, selectedOverlayId)
    : undefined

  /** Zooms so the whole timeline fits the visible strip. */
  function fitZoom() {
    const strip = document.querySelector('[data-testid=timeline-scroll]')
    const available = strip?.clientWidth ?? window.innerWidth
    setPixelsPerSecond(fitPixelsPerSecond(duration, available))
  }

  return (
    <div>
      <h1>Playback</h1>

      <p>
        <input type="file" accept="video/*" onChange={handleFileChange} />
      </p>

      <p>
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
      </p>

      <p>
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
      </p>

      {exportPercent !== null && <p>Exporting: {exportPercent}%</p>}

      {error !== null && <p style={{ color: 'red' }}>Error: {error}</p>}

      {sources.length > 0 && (
        <ul className="media-list" data-testid="media-list">
          {sources.map((source) => (
            <li key={source.id} data-testid="media-item">
              <span data-testid="media-name">{source.name}</span>{' '}
              <span className="media-meta">
                {source.width} x {source.height}
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

      {hasTimeline && (
        <p>
          Composition {displayProject.composition.width} x{' '}
          {displayProject.composition.height} &mdash; drag to move, drag an edge
          to trim, S to split at the playhead
        </p>
      )}

      <p className="overlay-form">
        <input
          type="text"
          value={overlayText}
          data-testid="overlay-text"
          onChange={(event) => {
            setOverlayText(event.target.value)
            if (selectedOverlay) {
              useTimelineStore.getState().setOverlayStyle({
                overlayId: selectedOverlay.id,
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
        {selectedOverlay && (
          <>
            {' '}
            <label>
              x{' '}
              <input
                type="number"
                data-testid="overlay-x"
                value={selectedOverlay.x}
                onChange={(event) =>
                  useTimelineStore.getState().setOverlayStyle({
                    overlayId: selectedOverlay.id,
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
                value={selectedOverlay.y}
                onChange={(event) =>
                  useTimelineStore.getState().setOverlayStyle({
                    overlayId: selectedOverlay.id,
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
                value={selectedOverlay.sizePx}
                onChange={(event) =>
                  useTimelineStore.getState().setOverlayStyle({
                    overlayId: selectedOverlay.id,
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
                value={selectedOverlay.color}
                onChange={(event) =>
                  useTimelineStore.getState().setOverlayStyle({
                    overlayId: selectedOverlay.id,
                    color: event.target.value,
                  })
                }
              />
            </label>{' '}
            <button
              type="button"
              data-testid="remove-overlay"
              onClick={() => {
                useTimelineStore
                  .getState()
                  .removeOverlay(selectedOverlay.id)
                setSelectedOverlayId(null)
              }}
            >
              Remove
            </button>
          </>
        )}
      </p>

      <canvas ref={canvasRef} style={{ maxWidth: '100%' }} />

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
        onClipGrab={handleClipGrab}
        pixelsPerSecond={pixelsPerSecond}
        onZoom={setPixelsPerSecond}
        selectedId={selectedOverlayId}
        onSelect={(id, target) =>
          setSelectedOverlayId(target === 'overlay' ? id : null)
        }
      />
    </div>
  )
}
