import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { createPlayer } from './player'
import { ThemeSelect } from './ui/ThemeSelect'
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
  draftName,
  parseDraftText,
  serializeDraft,
} from './timeline/draft'
import { timelineDuration } from './timeline/operations'
import {
  clearEverything,
  forgetMedia,
  loadAllMeasured,
  loadAllMedia,
  saveMeasured,
  UNTITLED,
  adoptLegacyProject,
  deleteProject,
  listProjects,
  loadProject as loadSavedProject,
  renameProject,
  type ProjectSummary,
  requestDurableStorage,
  saveMedia,
  saveProject,
  storageUsage,
} from './timeline/persistence'
import {
  clearSourceFiles,
  forgetSourceFile,
  hasSourceFile,
  getSourceFile,
  registerSourceFile,
} from './timeline/sourceRegistry'
import { captionSteps, segmentsUsing } from './assistant/captions'
import {
  readSpokenLanguage,
  writeSpokenLanguage,
} from './assistant/language'
import { requestTranscript, type Transcript } from './assistant/transcript'
import { shotBoundaries } from './assistant/shots'
import { signalsFor } from './assistant/signals'
import {
  VISION_MAX_FRAMES,
  VISION_SAMPLE_SECONDS,
  requestVisuals,
  type Visuals,
} from './assistant/vision'
import { loudSpans,
  quietSpans, removedMicros } from './timeline/silence'
import { useTimelineStore } from './timeline/store'
import {
  BLEND_MODES,
  DEFAULT_CHROMA_KEY,
  DEFAULT_TRANSITION_MICROS,
  EFFECT_KINDS,
  FONT_FAMILIES,
  MASK_SHAPES,
  TEXT_ALIGNMENTS,
  EXPORT_HEIGHTS,
  EXPORT_QUALITIES,
  TRANSITION_KINDS,
  effectAmountAt,
  exportDimensions,
  exportSettingsOf,
  findSegment,
  isAnimated,
  propertyAt,
  segmentDuration,
  MAIN_VIDEO_TRACK_ID,
  emptyProject,
  segmentLabel,
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
import Timeline, { type PeaksBySource } from './ui/Timeline'
import Assistant from './ui/Assistant'
import { readOpenProjectId, writeOpenProjectId } from './ui/openProject'
import { mediaKeyFor } from './timeline/mediaKey'

/** Which file each source is, for a map of restored media. */
function keysFor(media: Map<string, File>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [sourceId, file] of media) out[sourceId] = mediaKeyFor(file)
  return out
}

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
  // Stepped by a quarter turn, because that is what almost every rotation is:
  // footage that came out of a messaging app with its orientation metadata
  // stripped, and needs putting back the right way up. Any angle can still be
  // typed, and keyframed like every other property here.
  { property: 'rotation', label: 'rotate', step: 90, min: -360, max: 360 },
  { property: 'opacity', label: 'opacity', step: 0.05, min: 0, max: 1 },
]

/** How loud a segment is. Meaningless for a segment nobody hears. */
const LEVEL_FIELDS: PropertyField[] = [
  { property: 'volume', label: 'volume', step: 0.05, min: 0, max: 4 },
]

const EFFECT_KIND_NAMES = Object.keys(EFFECT_KINDS) as EffectKind[]

/**
 * How far an arrow key moves the playhead.
 *
 * A thirtieth of a second: sources differ in frame rate and the timeline has
 * no rate of its own, so this is a readable step rather than a real frame.
 */
const FRAME_STEP_MICROS = Math.round(1_000_000 / 30)

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

/*
 * Line art rather than emoji: an emoji is a font, and which one the machine has
 * decides how big it draws and whether it comes out in somebody else's colours.
 * These inherit currentColor and follow the theme.
 */
function FilmGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.5}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 9h18M3 15h18M8 5v14M16 5v14" />
    </svg>
  )
}

function WaveGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <path d="M4 12h2l2-6 3 14 3-11 2 3h4" />
    </svg>
  )
}

function SplitGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.7} strokeLinecap="round">
      <path d="M6 4v16M18 4v16M6 12h12" />
    </svg>
  )
}

function DuplicateGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.7} strokeLinecap="round"
      strokeLinejoin="round">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M4 16V6a2 2 0 012-2h10" />
    </svg>
  )
}

function EyeGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {/* An eye: what looking at the footage is. */}
      <path
        d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle cx="8" cy="8" r="1.8" fill="currentColor" />
    </svg>
  )
}

function ScriptGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {/* Lines of text on a page: what a transcript is. */}
      <path
        d="M3.5 2h9v12h-9zM5.5 5h5M5.5 7.5h5M5.5 10h3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  )
}

function SilenceGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {/* A waveform with its middle flattened: the shape of what this does. */}
      <path
        d="M1 8h1.5M4 4.5v7M6 6.5v3M8 8h4M14 5.5v5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

function TransitionGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.7} strokeLinecap="round">
      <path d="M4 12h16M14 6l6 6-6 6" />
    </svg>
  )
}

function TextGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.7} strokeLinecap="round">
      <path d="M5 7h14M12 7v12" />
    </svg>
  )
}

function TrashGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.7} strokeLinecap="round"
      strokeLinejoin="round">
      <path d="M6 7h12l-1 13H7L6 7zM9 7V4h6v3" />
    </svg>
  )
}

/**
 * The aspects of a selection, one per tab.
 *
 * "clip" is offered for anything at all, which is what keeps speed reachable
 * on a piece of music: an audio segment draws nothing, so it has no transform
 * and no compositing, but it still has a rate.
 */
type InspectorTab = 'clip' | 'audio' | 'effects' | 'text'

const TAB_LABELS: Record<InspectorTab, string> = {
  clip: 'Clip',
  audio: 'Audio',
  effects: 'Effects',
  text: 'Text',
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
  const [requestedTab, setRequestedTab] = useState<InspectorTab>('clip')
  const [pixelsPerSecond, setPixelsPerSecond] = useState(
    DEFAULT_PIXELS_PER_SECOND,
  )
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    null,
  )
  /**
   * Bumped whenever a file is handed to the source registry. The registry is
   * deliberately not store state, so nothing else would tell React that a
   * source stopped being offline.
   */
  const [relinkTick, setRelinkTick] = useState(0)
  /** When the timeline was last written to storage, for the saved indicator. */
  const [savedAt, setSavedAt] = useState<number | null>(null)

  /**
   * Which piece of work is open, and what it is called.
   *
   * WHICH ONE is a preference about this browser, exactly like the theme: it
   * says nothing about the work and must not travel in a draft. The NAME is
   * part of the work, and goes in the draft beside the project - but not
   * inside it, because nothing renders differently for being called anything.
   */
  /**
   * Whether the picture shows the footage as it ARRIVED rather than as edited.
   *
   * A way of looking, not an edit: nothing about the project changes, and the
   * timeline underneath goes on showing the cut. It is a toggle rather than two
   * pictures side by side because the second one would mean decoding the source
   * a second time, and a phone recording is expensive enough to decode once.
   */
  const [showOriginal, setShowOriginal] = useState(false)

  const [projectId, setProjectId] = useState<string | null>(null)
  const [projectName, setProjectName] = useState(UNTITLED)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [usage, setUsage] = useState<{
    usageBytes: number
    quotaBytes: number
  } | null>(null)
  /**
   * Until the saved project has been read back, nothing may be written over
   * it - an autosave fired by the empty starting state would erase the very
   * project it is about to restore.
   */
  const [restored, setRestored] = useState(false)
  /**
   * Waveforms, by source. Derived from the media rather than part of the
   * project, so they live here and never go near the store.
   */
  const [peaks, setPeaks] = useState<PeaksBySource>({})

  /**
   * What each source says, once somebody has asked.
   *
   * Kept here rather than in the store for the same reason the peaks are: it is
   * measured from the media, not authored, so it is not part of the project and
   * must never travel in a draft. Keyed by source, because a transcript belongs
   * to the FILE - split a clip in two and both halves are covered by the one
   * transcript, re-sliced.
   */
  /**
   * What each FILE says, keyed by media rather than by source.
   *
   * A sourceId is minted per import, so the same file brought into a second
   * project has a second one - and a transcript keyed by that would look lost
   * the moment somebody switched projects. See `mediaKey.ts`.
   */
  const [transcripts, setTranscripts] = useState<Record<string, Transcript>>({})

  /** Which file each source is, so the two keyings can be crossed. */
  const [mediaKeys, setMediaKeys] = useState<Record<string, string>>({})
  const [transcribing, setTranscribing] = useState(false)

  /**
   * What the transcriber should listen for. A preference about this browser, the
   * same as the theme, so it is read from storage rather than from the project
   * and never travels in a draft.
   */
  const [spokenLanguage, setSpokenLanguage] = useState(() =>
    readSpokenLanguage(globalThis.localStorage),
  )

  /**
   * What each source LOOKS like, once somebody has asked.
   *
   * Beside the transcripts and for the same reasons: derived from media rather
   * than authored, so it is not part of the project and never travels in a
   * draft. Keyed by source, because what was filmed belongs to the file.
   */
  const [visuals, setVisuals] = useState<Record<string, Visuals>>({})
  const [watching, setWatching] = useState(false)

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
   * Brings back whatever was open last time.
   *
   * The media comes back first, because the worker cannot decode a source it
   * has never been handed a file for - and the timeline is only published once
   * every source it names is either restored or known to be missing.
   */
  useEffect(() => {
    let cancelled = false

    async function restore() {
      try {
        // Which project was open is a preference about this browser, so it is
        // read from here rather than from the database.
        let wanted = readOpenProjectId(globalThis.localStorage)

        // A browser last used before projects had names has one project in the
        // old single slot. It is somebody's work; it gets an id rather than
        // being left where nothing will look for it again.
        const adopted = await adoptLegacyProject(wanted ?? crypto.randomUUID())
        if (adopted) wanted = adopted

        const known = await listProjects()
        if (cancelled) return
        setProjects(known)

        // Whatever was open, or the most recently saved, or nothing at all.
        const openId =
          (wanted && known.some((one) => one.id === wanted) ? wanted : null) ??
          known[0]?.id ??
          null

        const [saved, media, measured] = await Promise.all([
          openId ? loadSavedProject(openId) : Promise.resolve(null),
          loadAllMedia(),
          loadAllMeasured(),
        ])
        if (cancelled) return

        // An id exists from the first moment, so the first autosave has
        // somewhere to go rather than inventing a second project.
        const id = saved?.id ?? openId ?? crypto.randomUUID()
        setProjectId(id)
        setProjectName(saved?.name ?? UNTITLED)
        writeOpenProjectId(id, globalThis.localStorage)


        // What was worked out about the media last time. A transcript costs
        // minutes and a description costs money, so losing them on a reload
        // would have somebody pay for the same answer twice - and until they
        // did, the assistant would be blind and would rightly refuse to cut.
        const restoredScripts: Record<string, Transcript> = {}
        const restoredVisuals: Record<string, Visuals> = {}
        for (const [sourceId, value] of measured) {
          const entry = value as { transcript?: Transcript; visuals?: Visuals }
          if (entry?.transcript?.segments) {
            restoredScripts[sourceId] = entry.transcript
          }
          if (entry?.visuals?.shots) restoredVisuals[sourceId] = entry.visuals
        }
        if (Object.keys(restoredScripts).length > 0) {
          setTranscripts(restoredScripts)
        }
        if (Object.keys(restoredVisuals).length > 0) {
          setVisuals(restoredVisuals)
        }

        setMediaKeys(keysFor(media))

        if (saved) {
          for (const [sourceId, file] of media) {
            registerSourceFile(sourceId, file)
          }

          // Hand the worker every file before the project reaches it.
          await Promise.all(
            Object.keys(saved.project.sources)
              .filter((sourceId) => media.has(sourceId))
              .map((sourceId) =>
                playerRef.current
                  ?.probeSource(sourceId, media.get(sourceId)!)
                  .catch(() => undefined),
              ),
          )
          if (cancelled) return

          useTimelineStore.getState().openProject(saved.project)
          setSavedAt(saved.savedAt)
          setRelinkTick((tick) => tick + 1)
          exportNameRef.current =
            Object.values(saved.project.sources)[0]?.name ?? 'timeline'
        }
      } catch (err) {
        // A storage that cannot be read is not a reason to refuse to open.
        console.warn('[persistence] could not restore:', err)
      } finally {
        if (!cancelled) setRestored(true)
      }
    }

    void restore()
    void requestDurableStorage()
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Writes the timeline out shortly after it stops changing.
   *
   * Debounced rather than written per edit: dragging a slider commits a value
   * per frame, and each one would otherwise be a transaction.
   */
  useEffect(() => {
    if (!restored) return

    // No id means the restore has not finished working out which project this
    // is. Saving now would write a second one beside the one being opened.
    if (!projectId) return

    const timer = setTimeout(() => {
      void saveProject(projectId, projectName, project)
        .then((at) => {
          setSavedAt(at)
          setProjects((current) =>
            current.some((one) => one.id === projectId)
              ? current.map((one) =>
                  one.id === projectId
                    ? { ...one, name: projectName, savedAt: at }
                    : one,
                )
              : [{ id: projectId, name: projectName, savedAt: at }, ...current],
          )
          return storageUsage()
        })
        .then((next) => setUsage(next))
        .catch((err) => console.warn('[persistence] could not save:', err))
    }, 400)

    return () => clearTimeout(timer)
  }, [project, restored, projectId, projectName])

  /**
   * Measures the waveform of any source that carries sound and has not been
   * measured yet. Once per source, however many segments use it.
   */
  useEffect(() => {
    const wanted = new Set<string>()
    for (const track of project.tracks) {
      if (track.kind !== 'video' && track.kind !== 'audio') continue
      for (const segment of track.segments) {
        const sound = soundContent(segment)
        if (sound) wanted.add(sound.sourceId)
      }
    }

    for (const sourceId of wanted) {
      if (peaks[sourceId] || !hasSourceFile(sourceId)) continue

      // Marked as measured before the answer arrives, so a re-render while it
      // is in flight does not ask again.
      setPeaks((current) =>
        current[sourceId]
          ? current
          : {
              ...current,
              [sourceId]: {
                peaks: new Float32Array(0),
                bucketsPerSecond: 1,
              },
            },
      )

      void playerRef.current
        ?.sourcePeaks(sourceId)
        .then((measured) =>
          setPeaks((current) => ({ ...current, [sourceId]: measured })),
        )
        .catch((err) => console.warn('[waveform] could not measure:', err))
    }
  }, [project, peaks, relinkTick])

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
        return
      }

      const duration = timelineDuration(store.project)

      // Space is the one shortcut everybody tries first. It also scrolls the
      // page by default, hence the preventDefault.
      if (event.key === ' ') {
        event.preventDefault()
        const player = playerRef.current
        if (!player) return
        if (playingRef.current) player.pause()
        else player.play()
        return
      }

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        // A frame at a time, or a second with shift held.
        const step = event.shiftKey ? 1_000_000 : FRAME_STEP_MICROS
        const delta = event.key === 'ArrowLeft' ? -step : step
        seekFromUser(clampToTimeline(currentMicros + delta, duration))
        return
      }

      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        seekFromUser(
          event.key === 'Home' ? 0 : Math.max(0, duration - 1),
        )
        return
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!selectedSegmentId) return
        event.preventDefault()
        store.removeSegment(selectedSegmentId)
        setSelectedSegmentId(null)
        return
      }

      if (event.key === 'Escape') {
        setSelectedSegmentId(null)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentMicros, selectedSegmentId, seekFromUser])

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
      new Blob([serializeDraft(project, projectName)], {
        type: 'application/json',
      }),
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
      const text = await file.text()
      const project = parseDraftText(text)

      // Opened as its OWN project rather than over the top of the current one:
      // a file off somebody's disk is a separate piece of work, and writing it
      // into the open slot would quietly replace whatever was there.
      const id = crypto.randomUUID()
      const named =
        draftName(JSON.parse(text) as unknown) ??
        file.name.replace(/\.draft\.json$|\.json$/i, '') ??
        UNTITLED

      // A draft carries no media, so nothing that was open still applies.
      clearSourceFiles()
      useTimelineStore.getState().openProject(project)
      setSelectedSegmentId(null)
      setCurrentMicros(0)
      setProjectId(id)
      setProjectName(named)
      writeOpenProjectId(id, globalThis.localStorage)
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
      void saveMedia(sourceId, file).catch((err) =>
        console.warn('[persistence] could not keep the media:', err),
      )

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
          content: 'Text',
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
  /** How many segments are playing a source, which is what removing it costs. */
  function clipsUsing(sourceId: string): number {
    let count = 0
    for (const track of displayProject.tracks) {
      for (const segment of track.segments) {
        const content = segment.content
        if (content.kind !== 'text' && content.sourceId === sourceId) count += 1
      }
    }
    return count
  }

  /**
   * Says what will go, on the button itself. Removing a file takes its clips
   * with it, and a count is the difference between a safe click and a surprise -
   * there is no dialog here, undo is the safety net.
   */
  function removeSourceTitle(sourceId: string, name: string): string {
    const clips = clipsUsing(sourceId)
    if (clips === 0) return `Remove ${name}`
    return `Remove ${name} and the ${clips} clip${clips === 1 ? '' : 's'} using it`
  }

  /**
   * Forgets a file: the project reference, the clips playing it, the File held
   * for the decoder, and the copy kept for the next visit.
   *
   * The store change is one undo step. The two forgettings are NOT undone by it
   * - a File cannot be resurrected from a patch - so undo brings the timeline
   * back with that source offline, and the relink panel is how it comes back.
   * That is the same state a reopened draft starts in.
   */
  function forgetSource(sourceId: string) {
    const store = useTimelineStore.getState()
    const going = new Set(
      store.project.tracks.flatMap((track) =>
        track.segments
          .filter((segment) => {
            const content = segment.content
            return content.kind !== 'text' && content.sourceId === sourceId
          })
          .map((segment) => segment.id),
      ),
    )

    store.removeSource(sourceId)

    // The inspector must not go on describing a clip that is gone.
    if (selectedSegmentId !== null && going.has(selectedSegmentId)) {
      setSelectedSegmentId(null)
    }

    forgetSourceFile(sourceId)
    // What was MEASURED is deliberately left. It is keyed by the file rather
    // than by this import, so another project may still be using it - and it
    // cost minutes of somebody's machine or real money to work out. A few
    // kilobytes outliving their last user is much the cheaper mistake.
    void forgetMedia(sourceId).catch(() => {
      // It is already out of the project; a copy left behind is not worth
      // interrupting an edit over.
    })
  }

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
    setMediaKeys((current) => ({ ...current, [sourceId]: mediaKeyFor(file) }))
    // Kept so the next visit needs no re-picking. A failure here costs the
    // convenience, not the edit, so it is warned about rather than surfaced.
    void saveMedia(sourceId, file).catch((err: unknown) => {
      // Said out loud rather than only logged. A phone recording can be larger
      // than the whole storage quota, and the failure is silent until the next
      // visit - when the timeline comes back with nothing to decode from and
      // the reason is hours in the past.
      console.warn('[persistence] could not keep the media:', err)
      setError(
        `${file.name} is open, but too large to keep in this browser. It will` +
          ' have to be chosen again next time.',
      )
    })

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

  /** How long the EDIT is. The timeline always shows this, whatever is pictured. */
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

  const selectedSound = selectedSegment
    ? soundContent(selectedSegment)
    : undefined
  /** What was measured about the file a source plays, if anything was. */
  function measuredFor<T>(
    held: Record<string, T>,
    sourceId: string | undefined,
  ): T | undefined {
    const key = sourceId ? mediaKeys[sourceId] : undefined
    return key ? held[key] : undefined
  }

  const selectedTranscript = measuredFor(transcripts, selectedSound?.sourceId)

  /**
   * The footage before anybody touched it: one source, whole, at the head.
   *
   * Built as a PROJECT rather than as a special case in the player, so it goes
   * through the one render function like everything else - a second way to draw
   * a picture is the thing this codebase spends its life avoiding.
   *
   * The composition is kept, so the two views are the same shape and the
   * difference between them is only the editing.
   */
  const originalProject = useMemo(() => {
    const chosen =
      (selectedSound && displayProject.sources[selectedSound.sourceId]) ??
      Object.values(displayProject.sources)[0]
    if (!chosen) return null

    const before = emptyProject()
    before.composition = { ...displayProject.composition }
    before.sources = { [chosen.id]: chosen }

    const video = before.tracks.find((track) => track.id === MAIN_VIDEO_TRACK_ID)
    video?.segments.push({
      id: 'original',
      timelineStartMicros: 0,
      content: {
        kind: 'video',
        sourceId: chosen.id,
        sourceInMicros: 0,
        sourceOutMicros: chosen.durationMicros,
      },
    })
    return before
  }, [displayProject.sources, displayProject.composition, selectedSound])

  /** Which project the PICTURE is showing. The timeline always shows the edit. */
  const picturedProject: Project =
    showOriginal && originalProject !== null ? originalProject : displayProject

  const previewDuration = timelineDuration(picturedProject)

  /**
   * The worker renders whatever the project says, so any change republishes
   * it - and then re-renders the current position, because the same moment on
   * the timeline can show something different after a load, an edit or an undo.
   * Without the seek nothing appears until the user happens to click.
   */
  useEffect(() => {
    const player = playerRef.current
    if (!player) return

    player.setProject(picturedProject)
    if (playingRef.current) return

    const timelineEnd = timelineDuration(picturedProject)
    if (timelineEnd === 0) return

    const target = previewTargetRef.current ?? currentMicrosRef.current
    player.seek(Math.min(Math.max(0, target), timelineEnd - 1))
  }, [picturedProject])

  /**
   * Where nobody is speaking, for every source that has been transcribed.
   *
   * Sent to the assistant beside the words, because a cut boundary taken from a
   * transcript lands where a word BEGINS - a moment before the sound and a
   * moment after the breath before it - and cutting exactly there clips both.
   * Measured from the peaks, which are already there for the waveform.
   *
   * Only for transcribed sources: without the words there is nothing to place
   * against, and every other file's pauses would be paid for in every request.
   */
  /**
   * What the assistant is told, keyed by SOURCE.
   *
   * The measured things are held by file, because the same footage in two
   * projects is the same footage. The agent speaks source ids, because that is
   * what the timeline is made of. This is the one place the two are crossed.
   */
  const knowledgeForAssistant = useMemo(() => {
    const scripts: Record<string, Transcript> = {}
    const seen: Record<string, Visuals> = {}
    const pauses: Record<
      string,
      { startMicros: number; endMicros: number }[]
    > = {}
    const signals: Record<
      string,
      { clarity?: number; loudness?: number; repeatOf?: number }[]
    > = {}

    for (const sourceId of Object.keys(displayProject.sources)) {
      const key = mediaKeys[sourceId]
      if (!key) continue

      const transcript = transcripts[key]
      const visual = visuals[key]
      if (transcript) scripts[sourceId] = transcript
      if (visual) seen[sourceId] = visual

      // How clearly, how loudly, and whether it had already been said. All
      // arithmetic, and all of it invisible in the words themselves.
      if (transcript) {
        const measured = peaks[sourceId]
        signals[sourceId] = signalsFor(
          transcript.segments,
          measured && measured.peaks.length > 0 ? measured : undefined,
        )
      }

      // Pauses only where there are words to place against them; every other
      // file's would be paid for in every request for nothing.
      const measured = peaks[sourceId]
      const source = displayProject.sources[sourceId]
      if (!transcript || !measured || measured.peaks.length === 0 || !source) {
        continue
      }

      pauses[sourceId] = quietSpans(
        measured.peaks,
        measured.bucketsPerSecond,
        { startMicros: 0, endMicros: source.durationMicros },
      )
    }

    return { scripts, visuals: seen, pauses, signals }
  }, [transcripts, visuals, mediaKeys, peaks, displayProject.sources])

  /**
   * Whether there is anything to transcribe.
   *
   * `soundContent` says the segment is the KIND that can carry sound, which is
   * not the same as the file having any: a video shot with the microphone off
   * is still a video segment. The waveform is the honest answer, and it has
   * already been measured - no peaks means either silence or a measurement
   * still in flight, and neither is worth sending to a transcriber.
   */
  /**
   * Whether there is a picture to look at.
   *
   * The segment's kind is the honest answer here, unlike with sound: a video
   * segment always has frames, where a video file may well have no audio. A
   * source stored with no size is a piece of music, and has no picture at all.
   */
  const selectedCanWatch =
    selectedSegment?.content.kind === 'video' &&
    (displayProject.sources[selectedSegment.content.sourceId]?.width ?? 0) > 0

  const visualsForSelection =
    selectedSegment?.content.kind === 'video'
      ? measuredFor(visuals, selectedSegment.content.sourceId)
      : undefined

  const selectedCanTranscribe = selectedSound
    ? (peaks[selectedSound.sourceId]?.peaks.length ?? 0) > 0
    : false

  /**
   * Asks what the selection says.
   *
   * Two steps, and the first is the reason this is not simply a fetch: the audio
   * is decoded in the worker, by WebCodecs, exactly as it is for the preview and
   * the export. What goes to the transcriber is plain PCM, so no part of this
   * reaches for a second decoder.
   */
  async function transcribeSelection() {
    const player = playerRef.current
    if (!player || !selectedSound || transcribing) return

    const sourceId = selectedSound.sourceId
    setTranscribing(true)
    setError(null)

    try {
      const audio = await player.sourceAudioForTranscription(sourceId)
      const transcript = await requestTranscript(audio.samples, audio.sampleRate, {
        ...(spokenLanguage ? { language: spokenLanguage } : {}),
      })
      const key = mediaKeys[sourceId] ?? sourceId
      setTranscripts((current) => ({ ...current, [key]: transcript }))
      void rememberMeasured(key, { transcript })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setTranscribing(false)
    }
  }

  /**
   * Writes the open project before moving off it.
   *
   * The autosave is debounced, so a project edited and then left within that
   * window has never been written - and switching away would lose it. An EMPTY
   * one is deliberately not kept: an untouched editor is not work, and saving
   * it would put a blank project in the list every time somebody pressed New,
   * as well as making a fresh browser look like it already had something in it.
   */
  async function keepProject(id: string | null, name: string, open: Project) {
    if (!id) return

    const hasAnything =
      Object.keys(open.sources).length > 0 ||
      open.tracks.some((track) => track.segments.length > 0)
    if (!hasAnything) return

    const at = await saveProject(id, name, open)
    setProjects((current) =>
      current.some((one) => one.id === id)
        ? current.map((one) =>
            one.id === id ? { ...one, name, savedAt: at } : one,
          )
        : [{ id, name, savedAt: at }, ...current],
    )
  }

  /**
   * Opens another piece of work.
   *
   * The undo history is cleared, for the same reason opening a draft clears it:
   * undoing across the switch would walk into a timeline nobody has open. The
   * transcripts and descriptions are NOT cleared - they are keyed by source, so
   * a file used in two projects keeps what was worked out about it once.
   */
  async function openProjectById(id: string) {
    if (id === projectId) return

    // Captured before anything is awaited: the state these describe is replaced
    // below, and reading them afterwards would save the incoming project under
    // the outgoing one's id.
    const outgoing = {
      id: projectId,
      name: projectName,
      project: useTimelineStore.getState().project,
    }

    const saved = await loadSavedProject(id)
    if (!saved) return

    await keepProject(outgoing.id, outgoing.name, outgoing.project)

    const media = await loadAllMedia()
    for (const [sourceId, file] of media) registerSourceFile(sourceId, file)
    // The other project's imports are new source ids to this session, and
    // without their file identities nothing measured would be found for them.
    setMediaKeys(keysFor(media))

    // The database FIRST, then whatever this session already has open. A file
    // that could not be stored - a phone recording can be larger than the whole
    // quota - is still perfectly usable until the tab is closed, and refusing
    // to hand it over would strand a project that was working a moment ago.
    await Promise.all(
      Object.keys(saved.project.sources).map((sourceId) => {
        const file = media.get(sourceId) ?? getSourceFile(sourceId)
        if (!file) return undefined
        return playerRef.current?.probeSource(sourceId, file).catch(() => undefined)
      }),
    )

    setSelectedSegmentId(null)
    useTimelineStore.getState().openProject(saved.project)
    setProjectId(saved.id)
    setProjectName(saved.name)
    setSavedAt(saved.savedAt)
    writeOpenProjectId(saved.id, globalThis.localStorage)
    setRelinkTick((tick) => tick + 1)
    exportNameRef.current =
      Object.values(saved.project.sources)[0]?.name ?? saved.name
  }

  /**
   * Starts a new piece of work.
   *
   * Saved immediately rather than on the first edit, so it appears in the list
   * at once - a new project that vanished until it was touched would look like
   * the button had not worked.
   */
  async function createProject() {
    // The switch happens SYNCHRONOUSLY, before anything is awaited. Writing the
    // outgoing project first would leave a window in which the new project is
    // notionally open but the name field still belongs to the old one - and a
    // name typed into it would be wiped when this resumed.
    const outgoing = {
      id: projectId,
      name: projectName,
      project: useTimelineStore.getState().project,
    }

    const id = crypto.randomUUID()
    const fresh = emptyProject()

    setSelectedSegmentId(null)
    useTimelineStore.getState().openProject(fresh)
    setProjectId(id)
    setProjectName(UNTITLED)
    writeOpenProjectId(id, globalThis.localStorage)

    await keepProject(outgoing.id, outgoing.name, outgoing.project)

    const at = await saveProject(id, UNTITLED, fresh)
    setSavedAt(at)
    setProjects((current) =>
      current.some((one) => one.id === id)
        ? current
        : [{ id, name: UNTITLED, savedAt: at }, ...current],
    )
  }

  /**
   * Throws a project away.
   *
   * The media is left alone deliberately - a file can be in more than one
   * project and there is no way to know from here whether it is. Deleting the
   * one that is open moves to another rather than leaving nothing open.
   */
  async function removeProject(id: string) {
    await deleteProject(id)
    const left = projects.filter((one) => one.id !== id)
    setProjects(left)

    if (id !== projectId) return
    if (left[0]) {
      await openProjectById(left[0].id)
    } else {
      await createProject()
    }
  }

  /**
   * Keeps what was worked out about a source, without losing what else is known
   * about it.
   *
   * Read-modify-write rather than a plain put: transcribing and looking are
   * separate acts on the same file, and whichever happened second must not
   * erase the first.
   */
  async function rememberMeasured(
    sourceId: string,
    entry: { transcript?: Transcript; visuals?: Visuals },
  ) {
    try {
      const existing = (await loadAllMeasured()).get(sourceId) as
        | { transcript?: Transcript; visuals?: Visuals }
        | undefined
      await saveMeasured(sourceId, { ...existing, ...entry })
    } catch {
      // Not being able to remember it is not a reason to lose it from this
      // session, where it is already in state and already useful.
    }
  }

  /**
   * Looks at the selection, and asks what is in it.
   *
   * Three steps, and the middle one deliberately has no model in it: the worker
   * samples frames, `shotBoundaries` works out where the picture changed from
   * the numbers alone, and only the question of what is IN each shot is asked of
   * Claude. Where a cut is has one right answer and does not need paying for.
   *
   * This is the one thing in the application that sends footage anywhere.
   */
  async function watchSelection() {
    const player = playerRef.current
    if (!player || !selectedSegment || watching) return

    const content = selectedSegment.content
    if (content.kind !== 'video') return

    const sourceId = content.sourceId
    setWatching(true)
    setError(null)

    try {
      const sampled = await player.sampleSourceFrames(
        sourceId,
        VISION_SAMPLE_SECONDS * 1_000_000,
        VISION_MAX_FRAMES,
      )
      if (sampled.error) throw new Error(sampled.error)
      if (sampled.frames.length === 0) {
        throw new Error('There is no picture in this clip to look at.')
      }

      const source = displayProject.sources[sourceId]
      const boundaries = shotBoundaries(
        sampled.frames.map((frame) => ({
          atMicros: frame.atMicros,
          grid: frame.grid,
        })),
      )

      // What was actually looked at, which is not the whole file once the frame
      // cap bites. An agent told nothing would read the description as covering
      // all of it.
      const last = sampled.frames[sampled.frames.length - 1]!
      const lookedAtMicros = last.atMicros + VISION_SAMPLE_SECONDS * 1_000_000
      const wholeFile =
        !source || lookedAtMicros >= source.durationMicros

      const seen = await requestVisuals(
        sampled.frames,
        boundaries,
        Math.min(lookedAtMicros, source?.durationMicros ?? lookedAtMicros),
      )

      const kept = wholeFile
        ? seen
        : { ...seen, truncatedAfterSeconds: lookedAtMicros / 1_000_000 }
      const key = mediaKeys[sourceId] ?? sourceId
      setVisuals((current) => ({ ...current, [key]: kept }))
      void rememberMeasured(key, { visuals: kept })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setWatching(false)
    }
  }

  /**
   * Lays the transcript onto the text row as captions.
   *
   * Every segment playing the source is captioned, each through its own clock,
   * so a split or sped-up clip comes out right. The whole pass is ONE undo step:
   * captioning an interview is one decision, and taking it back a line at a time
   * would be unusable.
   */
  function addCaptionsFromTranscript() {
    if (!selectedSound) return

    const transcript = measuredFor(transcripts, selectedSound.sourceId)
    const textTrack = displayProject.tracks.find(
      (track) => track.kind === 'text',
    )
    if (!transcript || !textTrack) return

    const steps = segmentsUsing(displayProject, selectedSound.sourceId).flatMap(
      (segment) =>
        captionSteps(
          segment,
          transcript,
          textTrack,
          displayProject.composition,
          () => crypto.randomUUID(),
        ),
    )

    if (steps.length === 0) {
      setError('None of what was said falls inside the clips on the timeline.')
      return
    }

    useTimelineStore.getState().applyPlan(steps)
  }

  /**
   * What trimming silence out of the selection would do, or null if it would do
   * nothing.
   *
   * Worked out here rather than in the store because it needs the WAVEFORM, and
   * the waveform is measured from the media rather than being part of the
   * project - the same split the source registry already makes for the files.
   */
  const silenceTrim = useMemo(() => {
    if (!selectedSegment || !selectedSegmentId) return null

    const sound = soundContent(selectedSegment)
    if (!sound) return null

    const measured = peaks[sound.sourceId]
    if (!measured || measured.peaks.length === 0) return null

    const range = {
      startMicros: sound.sourceInMicros,
      endMicros: sound.sourceOutMicros,
    }
    const spans = loudSpans(measured.peaks, measured.bucketsPerSecond, range)

    // Nothing to keep means the whole selection is quiet. Cutting it all would
    // be a delete, and a trim button that sometimes deletes things is worse
    // than one that declines.
    if (spans.length === 0) return null

    const removed = removedMicros(spans, range)
    if (removed <= 0) return null

    return { spans, removed }
    // Memoised, and it matters: the playhead re-renders this component sixty
    // times a second while playing, and this walks every peak of the source.
    // On a three minute recording that was ten thousand comparisons a frame to
    // answer a question whose answer had not changed.
  }, [selectedSegment, selectedSegmentId, peaks])

  function trimSilence() {
    if (!selectedSegmentId || !silenceTrim) return

    useTimelineStore.getState().keepSourceSpans({
      segmentId: selectedSegmentId,
      spans: silenceTrim.spans,
      newSegmentIds: silenceTrim.spans
        .slice(1)
        .map(() => crypto.randomUUID()),
    })
  }

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

  /*
   * A new selection opens at its own most important aspect: a caption at its
   * words, anything else at the clip. Within one selection the tab you picked
   * stays picked - it is only a CHANGE of selection that re-homes it, because
   * a caption whose words you cannot see is a caption you cannot edit.
   *
   * Keyed on the id alone, deliberately. What the segment IS comes from the
   * same render, so listing it here would re-home the tab on every edit to it,
   * which is the opposite of what this is for.
   */
  useEffect(() => {
    setRequestedTab(selectedText ? 'text' : 'clip')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSegmentId])

  /**
   * Which tabs this selection has anything behind. The inspector offers only
   * what applies, so a tab with nothing in it is not a disabled tab - it is
   * not there at all.
   */
  const availableTabs: InspectorTab[] = selectedSegment
    ? ([
        'clip',
        selectedHasSound ? 'audio' : undefined,
        'effects',
        selectedText ? 'text' : undefined,
      ].filter(Boolean) as InspectorTab[])
    : []

  // The last line of defence: a tab the selection does not have cannot be the
  // active one, whatever was asked for.
  const activeTab: InspectorTab = availableTabs.includes(requestedTab)
    ? requestedTab
    : 'clip'

  /** What the action strip calls the selection - the block's own name. */
  const selectedName = selectedSegment
    ? segmentLabel(displayProject, selectedSegment) || 'caption'
    : undefined

  function splitAtPlayhead() {
    useTimelineStore.getState().splitSegmentAt({
      timelineMicros: currentMicros,
      newSegmentId: crypto.randomUUID(),
    })
  }

  /**
   * The verb form of a transition: on or off, at the length the panel would
   * have given it. Which KIND it is stays a field in the inspector - a verb
   * that also carried settings would be a second place to set them.
   */
  function toggleTransition() {
    if (!selectedSegmentId) return
    const store = useTimelineStore.getState()
    if (selectedSegment?.transitionIn) {
      store.removeTransition(selectedSegmentId)
      return
    }
    store.setTransition({
      segmentId: selectedSegmentId,
      kind: 'crossfade',
      durationMicros: DEFAULT_TRANSITION_MICROS,
    })
  }

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
        <span data-testid="time">
          {formatMicros(currentMicros)} / {formatMicros(previewDuration)}
        </span>
        {originalProject !== null && (
          <button
            type="button"
            data-testid="show-original"
            className={showOriginal ? 'compare is-original' : 'compare'}
            aria-pressed={showOriginal}
            title={
              showOriginal
                ? 'Showing the footage as it arrived. Click for the edit.'
                : 'Showing your edit. Click for the footage as it arrived.'
            }
            onClick={() => setShowOriginal((on) => !on)}
          >
            {showOriginal ? 'Before' : 'After'}
          </button>
        )}
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

        <ThemeSelect />

        <div className="draft-controls">
          <button
            type="button"
            className="export-button"
            onClick={() => playerRef.current?.exportMp4()}
            disabled={!hasTimeline || exportPercent !== null}
          >
            Export
          </button>{' '}
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
        <section className="panel" data-testid="project-panel">
          <h2 className="panel-title">Project</h2>
          <input
            type="text"
            className="project-name"
            data-testid="project-name"
            value={projectName}
            aria-label="Project name"
            onChange={(event) => setProjectName(event.target.value)}
            onBlur={() => {
              const named = projectName.trim() || UNTITLED
              setProjectName(named)
              if (projectId) void renameProject(projectId, named)
            }}
          />
          <button
            type="button"
            data-testid="project-new"
            className="project-new"
            onClick={() => void createProject()}
          >
            New project
          </button>
          {projects.length > 1 && (
            <ul className="project-list" data-testid="project-list">
              {projects.map((one) => (
                <li
                  key={one.id}
                  data-testid="project-item"
                  data-project-id={one.id}
                  className={one.id === projectId ? 'is-current' : undefined}
                >
                  <button
                    type="button"
                    className="project-open"
                    data-testid="project-open"
                    disabled={one.id === projectId}
                    onClick={() => void openProjectById(one.id)}
                  >
                    {one.id === projectId ? projectName : one.name}
                  </button>
                  <button
                    type="button"
                    className="project-remove"
                    data-testid="project-remove"
                    title={`Delete ${one.name}`}
                    onClick={() => void removeProject(one.id)}
                  >
                    &times;
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

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
                  <button
                    type="button"
                    className="media-remove"
                    title={removeSourceTitle(source.id, source.name)}
                    aria-label={removeSourceTitle(source.id, source.name)}
                    data-testid="remove-source"
                    data-source-id={source.id}
                    onClick={() => forgetSource(source.id)}
                  >
                    &times;
                  </button>
                  <button
                    type="button"
                    className="media-tile"
                    title={`Add ${source.name} to the timeline`}
                    data-testid="add-to-timeline"
                    data-source-id={source.id}
                    onClick={() => appendClip(source.id)}
                  >
                    <span
                      className="media-thumb"
                      data-kind={sourceHasVideo(source) ? 'video' : 'audio'}
                      aria-hidden="true"
                    >
                      {sourceHasVideo(source) ? <FilmGlyph /> : <WaveGlyph />}
                    </span>
                    <span data-testid="media-name">{source.name}</span>
                    <span className="media-meta">
                      {sourceHasVideo(source)
                        ? `${source.width} x ${source.height}`
                        : 'audio only'}
                    </span>
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
              + video
            </button>{' '}
            <button
              type="button"
              data-testid="add-text-track"
              onClick={() => addTrack('text')}
            >
              + text
            </button>{' '}
            <button
              type="button"
              data-testid="add-audio-track"
              onClick={() => addTrack('audio')}
            >
              + audio
            </button>
          </div>
          <ul className="track-list" data-testid="track-list">
            {[...displayProject.tracks].reverse().map((track) => {
              // The list runs top of the stack first, so "up" here is a HIGHER
              // index in the project. Getting that backwards would move rows
              // the opposite way from the arrow that was clicked.
              const index = displayProject.tracks.indexOf(track)
              const top = displayProject.tracks.length - 1

              return (
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
                    title="Move this row up the stack"
                    data-testid="track-up"
                    data-track-id={track.id}
                    disabled={index === top}
                    onClick={() =>
                      useTimelineStore
                        .getState()
                        .moveTrack({ trackId: track.id, index: index + 1 })
                    }
                  >
                    &#9650;
                  </button>
                  <button
                    type="button"
                    className="effect-remove"
                    title="Move this row down the stack"
                    data-testid="track-down"
                    data-track-id={track.id}
                    disabled={index === 0}
                    onClick={() =>
                      useTimelineStore
                        .getState()
                        .moveTrack({ trackId: track.id, index: index - 1 })
                    }
                  >
                    &#9660;
                  </button>
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
              )
            })}
          </ul>
        </section>

        <section
          className="panel"
          data-testid="storage-panel"
          // False until whatever was saved has been read back and published.
          // Anything reading the timeline before that is reading the empty
          // state it starts in rather than the project.
          data-restored={restored ? 'true' : 'false'}
        >
          <h2 className="panel-title">Saved</h2>
          <p
            className="panel-note"
            data-testid="storage-state"
            // The moment of the last write, so a test can wait for a NEW one
            // rather than for the fact that a save has ever happened.
            data-saved-at={savedAt ?? ''}
          >
            {savedAt === null
              ? 'Nothing saved yet.'
              : 'This project and its media are kept in this browser, and come'
                + ' back when you return.'}
          </p>
          {usage && usage.quotaBytes > 0 && (
            <p className="panel-note" data-testid="storage-usage">
              Using {(usage.usageBytes / 1e6).toFixed(1)} MB of{' '}
              {(usage.quotaBytes / 1e9).toFixed(1)} GB.
            </p>
          )}
          <button
            type="button"
            data-testid="clear-storage"
            onClick={() => {
              void clearEverything()
                .then(() => {
                  setSavedAt(null)
                  return storageUsage()
                })
                .then((next) => setUsage(next))
                .catch((err) => setError(String(err)))
            }}
          >
            Clear saved data
          </button>
        </section>

        <section className="panel shortcuts">
          <details>
            <summary>
              <h2 className="panel-title">Shortcuts</h2>
            </summary>
          <dl>
            <dt>Space</dt>
            <dd>play or pause</dd>
            <dt>&#8592; &#8594;</dt>
            <dd>step a frame; hold shift for a second</dd>
            <dt>Home / End</dt>
            <dd>jump to either end</dd>
            <dt>Delete</dt>
            <dd>remove what is selected</dd>
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
          </details>
        </section>
      </aside>
      <aside className="inspector" data-testid="inspector">
        {availableTabs.length > 0 && (
          <div className="inspector-tabs" role="tablist">
            {availableTabs.map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                data-testid={`tab-${tab}`}
                aria-selected={tab === activeTab}
                onClick={() => setRequestedTab(tab)}
              >
                {TAB_LABELS[tab]}
              </button>
            ))}
          </div>
        )}

        <div className="inspector-body">
        {selectedSegment === undefined && (
          <p className="panel-note" data-testid="inspector-empty">
            Select something on the timeline to change it.
          </p>
        )}
        {selectedText && selectedSegmentId && activeTab === 'text' && (
          <section className="panel" data-testid="caption-panel">
            <h2 className="panel-title">Caption</h2>
      <div className="overlay-form">
        <input
          type="text"
          value={selectedText.content}
          data-testid="overlay-text"
          onBlur={() => useTimelineStore.getState().endCoalescing()}
          onChange={(event) =>
            useTimelineStore.getState().setTextStyle({
              segmentId: selectedSegmentId,
              content: event.target.value,
            })
          }
        />
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
            <label>
              font{' '}
              <select
                data-testid="overlay-font"
                value={selectedText.fontFamily ?? 'sans-serif'}
                onChange={(event) =>
                  useTimelineStore.getState().setTextStyle({
                    segmentId: selectedSegmentId,
                    fontFamily: event.target.value,
                  })
                }
              >
                {FONT_FAMILIES.map((family) => (
                  <option key={family} value={family}>
                    {family}
                  </option>
                ))}
              </select>
            </label>{' '}
            <label>
              align{' '}
              <select
                data-testid="overlay-align"
                value={selectedText.align ?? 'left'}
                onChange={(event) =>
                  useTimelineStore.getState().setTextStyle({
                    segmentId: selectedSegmentId,
                    align: event.target
                      .value as (typeof TEXT_ALIGNMENTS)[number],
                  })
                }
              >
                {TEXT_ALIGNMENTS.map((align) => (
                  <option key={align} value={align}>
                    {align}
                  </option>
                ))}
              </select>
            </label>{' '}
            <label>
              bold{' '}
              <input
                type="checkbox"
                data-testid="overlay-bold"
                checked={selectedText.bold === true}
                onChange={(event) =>
                  useTimelineStore.getState().setTextStyle({
                    segmentId: selectedSegmentId,
                    bold: event.target.checked,
                  })
                }
              />
            </label>{' '}
            <label>
              italic{' '}
              <input
                type="checkbox"
                data-testid="overlay-italic"
                checked={selectedText.italic === true}
                onChange={(event) =>
                  useTimelineStore.getState().setTextStyle({
                    segmentId: selectedSegmentId,
                    italic: event.target.checked,
                  })
                }
              />
            </label>{' '}
            <label>
              outline{' '}
              <input
                type="number"
                min={0}
                data-testid="overlay-outline"
                onBlur={() => useTimelineStore.getState().endCoalescing()}
                value={selectedText.outlineWidthPx ?? 0}
                onChange={(event) =>
                  useTimelineStore.getState().setTextStyle({
                    segmentId: selectedSegmentId,
                    outlineWidthPx: Math.max(0, Number(event.target.value)),
                    outlineColor: selectedText.outlineColor ?? '#000000',
                  })
                }
              />
            </label>
            <label>
              <input
                type="color"
                data-testid="overlay-outline-color"
                value={selectedText.outlineColor ?? '#000000'}
                onChange={(event) =>
                  useTimelineStore.getState().setTextStyle({
                    segmentId: selectedSegmentId,
                    outlineColor: event.target.value,
                  })
                }
              />
            </label>{' '}
            <label>
              shadow{' '}
              <input
                type="number"
                min={0}
                data-testid="overlay-shadow"
                onBlur={() => useTimelineStore.getState().endCoalescing()}
                value={selectedText.shadowBlurPx ?? 0}
                onChange={(event) =>
                  useTimelineStore.getState().setTextStyle({
                    segmentId: selectedSegmentId,
                    shadowBlurPx: Math.max(0, Number(event.target.value)),
                    shadowColor: selectedText.shadowColor ?? '#000000',
                  })
                }
              />
            </label>{' '}
            <label>
              box{' '}
              <input
                type="checkbox"
                data-testid="overlay-box"
                checked={selectedText.backgroundColor !== undefined}
                onChange={(event) =>
                  useTimelineStore.getState().setTextStyle({
                    segmentId: selectedSegmentId,
                    backgroundColor: event.target.checked ? '#000000' : '',
                    backgroundPaddingPx:
                      selectedText.backgroundPaddingPx ??
                      Math.round(selectedText.sizePx * 0.25),
                  })
                }
              />
            </label>
            {selectedText.backgroundColor !== undefined && (
              <label>
                <input
                  type="color"
                  data-testid="overlay-box-color"
                  value={selectedText.backgroundColor}
                  onChange={(event) =>
                    useTimelineStore.getState().setTextStyle({
                      segmentId: selectedSegmentId,
                      backgroundColor: event.target.value,
                    })
                  }
                />
              </label>
            )}{' '}
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
        )}

        {selectedSegment && selectedSegmentId && selectedDraws && activeTab === 'clip' && (
          <section className="panel" data-testid="transform-panel">
            <h2 className="panel-title">Transform</h2>
            <div className="transform-form">
              {TRANSFORM_FIELDS.map(propertyField)}
            </div>
            {isAnimated(selectedSegment) && (
              <button
                type="button"
                className="clear-keyframes"
                data-testid="clear-keyframes"
                onClick={() =>
                  useTimelineStore
                    .getState()
                    .clearKeyframes({ segmentId: selectedSegmentId })
                }
              >
                Remove every keyframe
              </button>
            )}
          </section>
        )}

        {selectedSegment && selectedSegmentId && selectedDraws && activeTab === 'clip' && (
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

            {videoContent(selectedSegment) && (
              <>
                <label className="transform-field">
                  <span className="transform-label">key out</span>
                  <select
                    data-testid="chroma-toggle"
                    value={selectedSegment.chromaKey ? 'on' : 'off'}
                    onChange={(event) => {
                      const store = useTimelineStore.getState()
                      if (event.target.value === 'off') {
                        store.removeChromaKey(selectedSegmentId)
                        return
                      }
                      store.setChromaKey({ segmentId: selectedSegmentId })
                    }}
                  >
                    <option value="off">nothing</option>
                    <option value="on">a colour</option>
                  </select>
                  <span />
                </label>

                {selectedSegment.chromaKey && (
                  <>
                    <label className="transform-field">
                      <span className="transform-label">colour</span>
                      <input
                        type="color"
                        data-testid="chroma-color"
                        value={selectedSegment.chromaKey.color}
                        onChange={(event) =>
                          useTimelineStore.getState().setChromaKey({
                            segmentId: selectedSegmentId,
                            color: event.target.value,
                          })
                        }
                      />
                      <span />
                    </label>

                    {(
                      [
                        ['similarity', 'tolerance'],
                        ['smoothness', 'softness'],
                        ['spill', 'despill'],
                      ] as const
                    ).map(([field, label]) => (
                      <label key={field} className="transform-field">
                        <span className="transform-label">{label}</span>
                        <input
                          type="number"
                          step={0.02}
                          min={0}
                          max={1}
                          data-testid={`chroma-${field}`}
                          value={
                            selectedSegment.chromaKey?.[field] ??
                            DEFAULT_CHROMA_KEY[field]
                          }
                          onBlur={() =>
                            useTimelineStore.getState().endCoalescing()
                          }
                          onChange={(event) => {
                            const value = Number(event.target.value)
                            if (!Number.isFinite(value)) return
                            useTimelineStore.getState().setChromaKey({
                              segmentId: selectedSegmentId,
                              [field]: value,
                            })
                          }}
                        />
                        <span />
                      </label>
                    ))}
                  </>
                )}
              </>
            )}

            <p className="panel-note">
              A blend mode reads what is underneath, so a row below is drawn
              even where this one covers it.
            </p>
          </section>
        )}

        {selectedSegment && selectedSegmentId && activeTab === 'effects' && (
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
              {(selectedSegment.effects ?? []).map((effect, index) => {
                const spec = EFFECT_KINDS[effect.kind]
                const offsetMicros = offsetIn(selectedSegment, currentMicros)
                const chain = selectedSegment.effects ?? []

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
                      data-testid={`effect-up-${effect.kind}`}
                      title="Apply this effect earlier in the chain"
                      disabled={index === 0}
                      onClick={() =>
                        useTimelineStore.getState().moveEffect({
                          segmentId: selectedSegmentId,
                          effectId: effect.id,
                          index: index - 1,
                        })
                      }
                    >
                      &#9650;
                    </button>
                    <button
                      type="button"
                      className="effect-remove"
                      data-testid={`effect-down-${effect.kind}`}
                      title="Apply this effect later in the chain"
                      disabled={index === chain.length - 1}
                      onClick={() =>
                        useTimelineStore.getState().moveEffect({
                          segmentId: selectedSegmentId,
                          effectId: effect.id,
                          index: index + 1,
                        })
                      }
                    >
                      &#9660;
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

        {selectedSegment && selectedSegmentId && selectedHasSound && activeTab === 'audio' && (
          <section className="panel" data-testid="levels-panel">
            <h2 className="panel-title">Audio</h2>
            <div className="transform-form">{LEVEL_FIELDS.map(propertyField)}</div>
            <p className="panel-note">
              1 is the clip as recorded, 0 is silent. Keyframe it to fade.
            </p>
          </section>
        )}

        {selectedSegment && selectedSegmentId && selectedHasSound && activeTab === 'clip' && (
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

        {selectedSegment && selectedSegmentId && canTransition && activeTab === 'clip' && (
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
        </div>
      </aside>

      <Assistant
        playheadMicrosRef={currentMicrosRef}
        selectedSegmentId={selectedSegmentId}
        scripts={knowledgeForAssistant.scripts}
        pauses={knowledgeForAssistant.pauses}
        signals={knowledgeForAssistant.signals}
        visuals={knowledgeForAssistant.visuals}
        script={
          selectedTranscript && selectedSound
            ? {
                name:
                  displayProject.sources[selectedSound.sourceId]?.name ??
                  'this clip',
                segments: selectedTranscript.segments,
                ...(selectedTranscript.device
                  ? { device: selectedTranscript.device }
                  : {}),
              }
            : undefined
        }
        language={
          selectedCanTranscribe
            ? {
                code: spokenLanguage,
                busy: transcribing,
                onChange: (code) => {
                  setSpokenLanguage(code)
                  writeSpokenLanguage(code, globalThis.localStorage)
                },
              }
            : undefined
        }
      />

      <main className="stage">
        <div className="stage-status">
          {exportPercent !== null && (
            <p className="status status-busy">Exporting: {exportPercent}%</p>
          )}
          {error !== null && (
            <p className="status status-error" data-testid="stage-error">
              Error: {error}
            </p>
          )}
          {hasTimeline && (
            <p className="status" data-testid="stage-length">
              Composition {displayProject.composition.width} x{' '}
              {displayProject.composition.height} &middot;{' '}
              {formatMicros(duration)}
              {originalProject !== null &&
                timelineDuration(originalProject) !== duration && (
                  <span className="status-compare" data-testid="stage-compare">
                    {' '}
                    &middot; {formatMicros(
                      timelineDuration(originalProject) - duration,
                    )}{' '}
                    shorter than the original
                  </span>
                )}
            </p>
          )}
        </div>

        <div className="stage-canvas">
          <canvas ref={canvasRef} />
        </div>
      </main>

      <div className="actions" data-testid="actions">
        <div className="actions-subject">
          {selectedSegment ? (
            <>
              <span
                className="actions-swatch"
                data-kind={selectedSegment.content.kind}
                aria-hidden="true"
              />
              <span className="actions-name" data-testid="actions-name">
                {selectedName}
              </span>
              <span className="actions-range">
                {formatMicros(selectedSegment.timelineStartMicros)}
                {'–'}
                {formatMicros(
                  selectedSegment.timelineStartMicros +
                    segmentDuration(selectedSegment),
                )}
              </span>
            </>
          ) : (
            <span className="actions-empty">Nothing selected</span>
          )}
        </div>

        <div className="actions-verbs">
          <button
            type="button"
            data-testid="verb-split"
            onClick={splitAtPlayhead}
            disabled={!selectedSegmentId}
          >
            <SplitGlyph />
            Split
          </button>
          <button
            type="button"
            data-testid="verb-duplicate"
            onClick={() => {
              if (!selectedSegmentId) return
              useTimelineStore.getState().duplicateSegment({
                segmentId: selectedSegmentId,
                newSegmentId: crypto.randomUUID(),
              })
            }}
            disabled={!selectedSegmentId}
          >
            <DuplicateGlyph />
            Duplicate
          </button>
          <button
            type="button"
            data-testid="verb-trim-silence"
            title={
              silenceTrim
                ? `Cut ${(silenceTrim.removed / 1_000_000).toFixed(2)}s of silence out of this clip`
                : 'No silence worth cutting in this clip'
            }
            onClick={trimSilence}
            disabled={silenceTrim === null}
          >
            <SilenceGlyph />
            Trim silence
          </button>
          <button
            type="button"
            data-testid="verb-transcribe"
            title={
              selectedTranscript
                ? 'Listen again - try a different spoken language if it came back wrong'
                : selectedCanTranscribe
                  ? 'Work out what is said in this clip. Runs locally and takes a while.'
                  : 'There is no sound in this clip to transcribe'
            }
            onClick={() => void transcribeSelection()}
            disabled={!selectedCanTranscribe || transcribing}
          >
            <ScriptGlyph />
            {transcribing
              ? 'Listening...'
              : selectedTranscript
                ? 'Transcribe again'
                : 'Transcribe'}
          </button>
          <button
            type="button"
            data-testid="verb-watch"
            title={
              !selectedCanWatch
                ? 'There is no picture in this selection to look at'
                : visualsForSelection
                  ? 'Look again'
                  : 'Look at the footage. THIS SENDS FRAMES OF YOUR VIDEO TO ANTHROPIC.'
            }
            onClick={() => void watchSelection()}
            disabled={!selectedCanWatch || watching}
          >
            <EyeGlyph />
            {watching
              ? 'Looking...'
              : visualsForSelection
                ? 'Watch again'
                : 'Watch'}
          </button>
          <button
            type="button"
            data-testid="verb-captions"
            title={
              selectedTranscript
                ? 'Lay what is said onto the text row as captions'
                : 'Transcribe the clip first'
            }
            onClick={addCaptionsFromTranscript}
            disabled={!selectedTranscript}
          >
            <TextGlyph />
            Captions
          </button>
          <button
            type="button"
            data-testid="verb-transition"
            className={selectedSegment?.transitionIn ? 'is-current' : undefined}
            onClick={toggleTransition}
            disabled={!canTransition}
          >
            <TransitionGlyph />
            Transition
          </button>
          <button
            type="button"
            data-testid="add-overlay"
            onClick={addOverlayAtPlayhead}
            disabled={!hasTimeline}
          >
            <TextGlyph />
            Add text
          </button>
          <button
            type="button"
            data-testid="verb-delete"
            onClick={() => {
              if (!selectedSegmentId) return
              useTimelineStore.getState().removeSegment(selectedSegmentId)
              setSelectedSegmentId(null)
            }}
            disabled={!selectedSegmentId}
          >
            <TrashGlyph />
            Delete
          </button>
        </div>
      </div>

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
          peaks={peaks}
        />
      </footer>
    </div>
  )
}
