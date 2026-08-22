import type { createPlayer } from '../src/player'

declare global {
  interface Window {
    harness: {
      generateFixture(options: {
        frames: number
        width: number
        height: number
        fps: number
      }): Promise<number[]>
      load(
        url: string,
      ): Promise<{ width: number; height: number; durationMicros: number } | null>
      loadExported(): Promise<{
        width: number
        height: number
        durationMicros: number
      } | null>
      pixelsAt(micros: number): Promise<number[]>
      exportMp4(): Promise<{ byteLength: number }>
      playThrough(): Promise<ReturnType<ReturnType<typeof createPlayer>['stats']>>
      frameCounts(): Promise<{
        worker: { created: number; closed: number }
        main: { created: number; closed: number }
      }>
      duration(): number
    }
  }
}
