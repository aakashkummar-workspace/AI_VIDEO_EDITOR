# Video Editor - architecture rules

- ONE render function. `renderFrame(state, timeMs)` is used by
  BOTH the preview and the export. Never write a second one.
- All video decoding happens in a Web Worker. Main thread = UI only.
- Every VideoSample and every VideoFrame must be closed exactly once,
  in a `finally` block. mediabunny's `VideoSampleSink` returns a
  `VideoSample` - a wrapper that owns the underlying VideoFrame - not
  a raw VideoFrame. Closing the wrapper closes the frame it owns.
  `sample.toVideoFrame()` hands you a separate VideoFrame that you
  must close yourself, in addition to the sample.
  Leaking either will crash the browser tab.
- Timeline state is plain JSON. No class instances, no GPU objects.
- All time values are integers in MICROSECONDS. Never seconds,
  never floats.
- EXCEPTION: mediabunny's sink API speaks SECONDS as floats
  (`sink.getSample(timestamp)`, `sink.samples(start, end)`,
  `track.getFirstTimestamp()`). Convert at the sink boundary and
  nowhere else: microseconds -> seconds on the way in, and
  `sample.microsecondTimestamp` on the way out. Never let a float
  second value travel further into the app than the call site.
- Do not add a feature without a test, and do not add one without the whole
  suite passing. `npm test` runs the vitest unit tests and then the Playwright
  browser tests; both must be green.
- The golden-frame test (`tests/golden-frame.spec.ts`) is the safety net for
  the render rule above: it renders the same frame through the preview and
  through the export and fails if the pixels diverge. Never widen its tolerance
  to make a change pass - a bigger diff means the pipelines drifted apart.
- The leak test (`tests/frame-leaks.spec.ts`) requires
  `created === closedInWorker + closedOnMain` after a full play-through.
  Too few closes is a leak; too many is a double close.
- The test clip is committed at `tests/fixtures/`. Regenerate it with
  `npm run fixture`, which encodes it with WebCodecs in a real browser.
  Never use ffmpeg or ffmpeg.wasm, in tests or anywhere else.
- The AUDIO CLOCK is authoritative. `AudioContext.currentTime` drives
  playback and video follows it, even when the timeline is silent - a
  silent project schedules nothing but still reads its position from
  the audio clock. There is deliberately no second clock path: a
  fallback used only by silent projects would take all the testing
  while the audio path took all the risk. Never reintroduce
  `performance.now()` as a position source.
- Audio sync is tested by frequency, not by ear. The tone fixtures
  carry one pure tone per second, so a decoded window can be traced
  back to the timeline second it came from
  (`tests/audio-sync.spec.ts`). Live drift is NOT in the suite - it
  depends on wall-clock scheduling and would flake; run
  `npm run drift` by hand instead.
- The Playwright browser runs with `--autoplay-policy=
  no-user-gesture-required`, because an AudioContext stays suspended
  until a user gesture and the tests drive playback directly. That
  flag is for the test browser only; the app relies on the Play click.
- Seek cost was measured on synthetic H.264 only (worst case 95ms, a
  1280x720 clip with a single keyframe). Re-run
  `node scripts/measure-seek.mjs` before trusting the decode buffer
  margin on real camera footage, 60fps, or 4K.

# Stack
Vite + React + TypeScript, pixi.js, mediabunny, zustand + immer
