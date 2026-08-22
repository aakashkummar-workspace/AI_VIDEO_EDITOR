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
        sourceUrl: string
        sourceDurationMicros: number
        clips: {
          sourceInMicros: number
          sourceOutMicros: number
          timelineStartMicros: number
        }[]
      }): Promise<{
        width: number
        height: number
        durationMicros: number
      } | null>
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
      frameCounts(): Promise<{
        worker: { created: number; closed: number }
        main: { created: number; closed: number }
      }>
      duration(): number
    }
  }
}
