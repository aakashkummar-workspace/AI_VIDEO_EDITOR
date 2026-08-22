import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { createPlayer } from './player'
import { exportFileName, formatMicros } from './playback'
import { timelineDuration } from './timeline/operations'
import { clearSourceFiles, registerSourceFile } from './timeline/sourceRegistry'
import { useTimelineStore } from './timeline/store'
import Timeline from './ui/Timeline'

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<ReturnType<typeof createPlayer> | null>(null)
  const sourceNameRef = useRef('video')

  const project = useTimelineStore((state) => state.project)

  const [error, setError] = useState<string | null>(null)
  const [currentMicros, setCurrentMicros] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [exportPercent, setExportPercent] = useState<number | null>(null)

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
    playerRef.current?.setProject(project)
  }, [project])

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
      store.setComposition({
        width: geometry.width,
        height: geometry.height,
      })
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

  const duration = timelineDuration(project)
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
          {project.composition.width} x {project.composition.height}
        </p>
      )}

      <canvas ref={canvasRef} style={{ maxWidth: '100%' }} />

      <Timeline
        project={project}
        currentMicros={currentMicros}
        onSeek={(micros) => playerRef.current?.seek(micros)}
      />
    </div>
  )
}
