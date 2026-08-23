import type { createPlayer } from '../src/player'

declare global {
  interface Window {
    /** Dev-only test seam exposed by src/timeline/store.ts. */
    __timelineStore: typeof import('../src/timeline/store').useTimelineStore
    harness: {
      generateFixture(options: {
        frames: number
        width: number
        height: number
        fps: number
      }): Promise<number[]>
      loadProject(spec: {
        composition: { width: number; height: number }
        sources: { id: string; url: string }[]
        clips: {
          sourceId: string
          sourceInMicros: number
          sourceOutMicros: number
          timelineStartMicros: number
        }[]
      }): Promise<{
        width: number
        height: number
        durationMicros: number
      } | null>
      addSourceFromUrl(
        url: string,
        sourceId: string,
      ): Promise<{
        durationMicros: number
        hasVideo: boolean
        width: number
        height: number
      }>
      loadExported(): Promise<{
        width: number
        height: number
        durationMicros: number
      } | null>
      pixelsAt(micros: number): Promise<number[]>
      exportMp4(): Promise<{ byteLength: number }>
      playThrough(): Promise<
        ReturnType<ReturnType<typeof createPlayer>['stats']> & {
          times: number[]
        }
      >
      setProject(project: unknown): void
      audioWindows(options: {
        url?: string
        windowMicros: number
        candidatesHz: number[]
        silenceRms?: number
      }): Promise<{
        sampleRate: number
        windows: {
          startMicros: number
          rms: number
          silent: boolean
          dominantHz: number | null
        }[]
      }>
      frameCounts(): Promise<{
        worker: { created: number; closed: number }
        main: { created: number; closed: number }
        openSources: number
      }>
      duration(): number
    }
  }
}
