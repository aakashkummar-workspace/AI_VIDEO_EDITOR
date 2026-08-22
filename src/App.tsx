import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { createPlayer } from './player'
import { exportFileName, formatMicros } from './playback'
import {
  applyDrag,
  dragPreviewMicros,
  dragToOperation,
  type ClipDrag,
  type DragMode,
} from './timeline/dragging'
import { pixelsToMicros } from './timeline/layout'
import { timelineDuration } from './timeline/operations'
import { clearSourceFiles, registerSourceFile } from './timeline/sourceRegistry'
import { useTimelineStore } from './timeline/store'
import type { Project } from './timeline/types'
import Timeline from './ui/Timeline'

/** A gesture in progress. Nothing here has reached the undo history yet. */
type ActiveDrag = {
  clipId: string
  mode: DragMode
  startClientX: number
  moved: boolean
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<ReturnType<typeof createPlayer> | null>(null)
  const sourceNameRef = useRef('video')

  const project = useTimelineStore((state) => state.project)

  const [error, setError] = useState<string | null>(null)
  const [currentMicros, setCurrentMicros] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [exportPercent, setExportPercent] = useState<number | null>(null)
  /** What the timeline and canvas show mid-drag, before anything is committed. */
  const [previewProject, setPreviewProject] = useState<Project | null>(null)

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
        link.download = exportFileName(sourceNameRef.current)
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

  // The worker renders whatever the project says, so any edit republishes it.
  useEffect(() => {
    playerRef.current?.setProject(displayProject)
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
    (clipId: string, mode: DragMode, clientX: number) => {
      dragRef.current = { clipId, mode, startClientX: clientX, moved: false }
    },
    [],
  )

  useEffect(() => {
    function onMouseMove(event: globalThis.MouseEvent) {
      const drag = dragRef.current
      if (!drag) return

      const deltaMicros = pixelsToMicros(event.clientX - drag.startClientX)
      if (deltaMicros === 0 && !drag.moved) return
      drag.moved = true

      const gesture: ClipDrag = {
        clipId: drag.clipId,
        mode: drag.mode,
        deltaMicros,
      }
      const preview = applyDrag(projectRef.current, gesture)
      setPreviewProject(preview)

      const previewMicros = dragPreviewMicros(preview, gesture)
      if (previewMicros !== null) seek(previewMicros)
    }

    function onMouseUp(event: globalThis.MouseEvent) {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      setPreviewProject(null)

      if (!drag.moved) return
      swallowNextSeekRef.current = true

      // One operation, so one undo step, no matter how many mousemoves it took.
      const gesture: ClipDrag = {
        clipId: drag.clipId,
        mode: drag.mode,
        deltaMicros: pixelsToMicros(event.clientX - drag.startClientX),
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
  }, [seek])

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

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return

    setError(null)
    setCurrentMicros(0)
    setExportPercent(null)
    sourceNameRef.current = file.name

    // One source at a time until the timeline can hold more.
    const store = useTimelineStore.getState()
    store.reset()
    clearSourceFiles()

    const sourceId = crypto.randomUUID()
    registerSourceFile(sourceId, file)

    try {
      const geometry = await playerRef.current!.probeSource(sourceId, file)

      // The composition defaults to the first source, then it is the user's.
      store.setComposition({ width: geometry.width, height: geometry.height })
      store.addSource({
        id: sourceId,
        name: file.name,
        durationMicros: geometry.durationMicros,
        width: geometry.width,
        height: geometry.height,
        rotation: geometry.rotation,
      })
      store.addClip({
        id: crypto.randomUUID(),
        sourceId,
        sourceInMicros: 0,
        sourceOutMicros: geometry.durationMicros,
        timelineStartMicros: 0,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const duration = timelineDuration(displayProject)
  const hasTimeline = duration > 0

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

      {exportPercent !== null && <p>Exporting: {exportPercent}%</p>}

      {error !== null && <p style={{ color: 'red' }}>Error: {error}</p>}

      {hasTimeline && (
        <p>
          {displayProject.composition.width} x{' '}
          {displayProject.composition.height} &mdash; drag to move, drag an edge
          to trim, S to split at the playhead
        </p>
      )}

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
      />
    </div>
  )
}
