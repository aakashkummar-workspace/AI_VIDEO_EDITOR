# Video Editor - architecture rules

- ONE render function. `renderFrame(state, timeMs, layers)` is used by
  BOTH the preview and the export. Never write a second one.
- All video decoding happens in a Web Worker. Main thread = UI only.
- Every VideoSample and every VideoFrame must be closed exactly once,
  in a `finally` block. mediabunny's `VideoSampleSink` returns a
  `VideoSample` - a wrapper that owns the underlying VideoFrame - not
  a raw VideoFrame. Closing the wrapper closes the frame it owns.
  `sample.toVideoFrame()` hands you a separate VideoFrame that you
  must close yourself, in addition to the sample.
  A `frame.clone()` is a THIRD handle with its own lifetime and its
  own close; stacked rows rely on cloning, and `frameTracker` counts a
  clone as a creation so the leak invariant still balances.
  Leaking any of them will crash the browser tab.
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
- Seek cost has been measured on real footage as well as synthetic:
  832x464 phone video with 1s GOPs seeks in 12ms median, 26ms worst,
  and our own exported files (2s GOPs) in 29ms median, 54ms worst -
  all far inside the 400ms decode buffer. The synthetic worst case
  remains 95ms (a 1280x720 clip with a single keyframe). Re-measure
  with `npm run fixture`-independent files via
  `node scripts/measure-seek.mjs <path under the project>` before
  trusting the margin at 60fps or 4K.
- Never schedule one Web Audio node per decoded packet. Rendering a
  2 minute timeline that way took OfflineAudioContext 80 seconds;
  joining contiguous packets into runs first takes 42ms. Measure a
  real export with `npm run export:measure <path>` after touching the
  mix.

# The timeline model

- A project is an ordered stack of TRACKS, bottom of the stack first.
  A track holds SEGMENTS. A segment carries either video (a source and
  an in/out range) or text (its own words and its own stored duration).
  There is ONE move and ONE trim, not one per kind of thing: what
  differs between a clip and a caption is what it draws and whether its
  row allows overlap, and both are properties of the TRACK. Never add a
  parallel set of operations for a new kind of segment.
- A video segment's duration is DERIVED from its source range. Only
  text stores a duration, because it has no source to derive one from.
  Never store a duration next to a range that already implies it.
- Rows composite bottom upwards. `visibleVideoSegmentsAt` decides which
  ones have to be drawn and stops at the first one that covers the
  composition opaquely; a segment that is scaled, moved or faded stops
  hiding what is under it, and letterbox bars are holes, not coverage.
- THE TRAP, and it has already been paid for once: the worker and
  `renderFrame` must never decide separately what is showing. The
  decoder walks each row on its own and merges; renderFrame picks what
  to paint. Anything that resolves "which segment is visible" twice
  drifts, and it drifts silently in the export only. The golden-frame
  test is what caught it.
- Keyframe offsets are measured from the SEGMENT HEAD, never from the
  timeline, so an animation survives a move and a trim. Values are
  resolved at render time by `transformAt` / `effectAmountAt` and never
  stored resolved.
- An effect at its kind's neutral amount, and a segment with an
  identity transform, must render byte for byte as if neither existed.
  That is what keeps the golden-frame comparison meaningful.
- The COMPOSITION is what the project is authored at; the EXPORT SIZE is
  what the file is written at, and they are allowed to differ. The
  render function only ever draws in composition coordinates - the
  export scales its context ONCE before the loop, so a different
  resolution can only make the same picture larger or smaller. Never
  teach renderFrame about the output size.
- The decode buffer is bounded by FRAMES, not by items. One item holds
  one frame per drawn row, so counting items would let memory grow with
  the number of rows while the cap looked unchanged. There is an item
  bound too, because a run of gaps carries no frames at all.
- Every animatable scalar lives in one place: `segment.properties` for
  the fixed value and `segment.keyframes` for the curve, resolved by
  `propertyAt`. Volume is NOT a transform - it moves nothing on screen -
  but it animates by identical rules, so it is in the same list rather
  than bolted on beside it. Add the next one there too.
- Every row that makes a sound is mixed: audio rows and video rows
  alike, since a clip carries its own audio and a row hidden behind
  another is still heard. Only text is silent.
- VOLUME IS APPLIED TO THE SAMPLES, in the worker, as they come out of
  the decoder. Not to a gain node: live playback schedules buffers and
  the export renders offline, and two mechanisms would each need their
  own envelope and could each get it wrong. Scaling the PCM once means
  there is one answer to how loud something is. It is read per sample
  when animated, so a fade is a ramp and not a staircase at the packet
  boundaries.
- A source with no picture is stored with a width and height of ZERO,
  which is the honest answer to how big its picture is, and is what
  `sourceHasVideo` reads. Opening one must never set the composition:
  a piece of music has no shape to offer.
- A draft file (`draft.ts`) is data off someone's disk: parse it field
  by field into a fresh object, never cast it. It carries no media, so
  reopening one leaves its sources offline until files are handed back.
  Opening a draft clears the undo history - undoing across it would
  walk into a timeline the user has closed.

# Stack
Vite + React + TypeScript, pixi.js, mediabunny, zustand + immer
