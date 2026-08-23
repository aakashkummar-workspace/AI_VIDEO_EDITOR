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
- A segment's duration stays DERIVED once speed exists: the source
  range and the RATE together imply it. Never clamp `segmentDuration`
  to a minimum - a segment too short to exist has to be visible as such
  or the checks that reject one have nothing to see.
- `sourceMicrosAt` is the ONE place timeline time becomes source time.
  Anything deciding which frame or which sample to fetch goes through
  it, so the decoder and the renderer cannot disagree about where in a
  clip they are.
- Speed is applied to audio by reporting the buffer at a MULTIPLIED
  sample rate and letting the audio graph resample it. That is what
  bounds the rate to 0.25x-4x: four times 48kHz is 192kHz, which the
  platform accepts, and forty times is not. It shifts pitch, exactly as
  speeding up a tape does. Preserving pitch needs a real time-stretch
  and is a different feature.
- `rate` is deliberately NOT one of the animatable properties. Those
  are values read AT a time; the rate defines what time means for the
  segment, so a keyframe on it would be circular. Speed ramps need the
  integral of a rate curve and are a separate feature.
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
- A packed row allows exactly ONE kind of overlap: a transition, and by
  exactly its own length. Two clips cannot dissolve without both being
  on screen, so applying one slides the incoming segment and everything
  after it earlier, and the project gets that much shorter. Nothing
  else may overlap, and `assertNoOverlap` is where that is decided.
- No extra footage is needed for a transition, and none may be
  invented: the incoming segment's own first frames play ACROSS the cut
  instead of after it. If you ever find yourself reaching past a
  segment's sourceOut, the model has been misunderstood.
- A crossfade is not computed. Drawing the incoming side at progress p
  over a solid outgoing side IS `in*p + out*(1-p)` - the dissolve falls
  out of alpha compositing. Do not add a blend path beside it.
- A transition needs two segments of ONE row on screen at once, which
  one iterator cannot yield. Each video row therefore has two decode
  streams: what it is playing, and what is blending into it. Two
  transitions are never allowed to overlap, so two streams is always
  enough - keep that invariant if you add anything here.
- The 2D canvas already does all fifteen CSS blend modes and
  destination-in masking, in the worker as well as on the main thread.
  Measured, not assumed. Only per-pixel work - chroma key, colour LUTs -
  is a reason to reach for WebGL, and rewriting the one render function
  is not a thing to do speculatively.
- A blend mode is a function OF what is underneath and a mask leaves
  parts of it showing, so `occludesEverything` must refuse both. Get
  this wrong and a multiply composites against black, which looks
  nearly right and is not.
- A mask is cut on a SCRATCH LAYER, never in place: `destination-in` on
  the composition would take the rows underneath with it. The feather is
  a blur on the mask shape, not a gradient per side.
- Per-pixel work runs as a PRE-PASS in `gpu.ts`, never by rewriting the
  render function. A frame goes through a shader, comes back as
  something `drawImage` accepts, and renderFrame draws it exactly as it
  draws a decoded frame - so the transform, mask, blend mode,
  transitions and text keep working untouched. Measure before reaching
  for a renderer rewrite: blend modes, masks and keying were all
  claimed to need one and none of them did.
- The GL context is cached PER OWNER, one for the preview thread and one
  for the export worker. Browsers drop the oldest context once a page
  holds a dozen, so one per frame exhausts them within a second.
- No WebGL is not an error. Draw the frame unkeyed: a picture with its
  background still in it beats no picture at all.
- NOUNS ARE IN THE COLUMNS, VERBS ARE IN THE STRIP. The left column is
  what the PROJECT is, the right column is what the SELECTION is, and
  the strip between the picture and the timeline is what you can DO -
  to the selection, or to the timeline. "Add text" is a verb and lives
  in the strip even though it acts on the project; scale is a noun and
  lives on the right. Nothing appears in two of them, or the two can
  disagree about whether it is enabled. Adding a panel to whichever
  column is nearest is how the sidebar became thirteen panels deep.
- The verbs in the strip run the SAME store operations the keyboard
  shortcuts do. A verb is a second way to reach an edit, never a second
  implementation of it, and never a place settings live: the transition
  verb applies one at the default length and the KIND stays a field.
- The inspector is TABBED, one aspect per tab, and `clip` is the tab
  anything can have - a piece of music draws nothing, so it has no
  transform and no compositing, but it still has a rate, and a first
  tab about the picture would put speed out of reach. A tab with
  nothing behind it is not offered rather than offered empty, and a tab
  that stops applying when the selection changes falls back to `clip`.
- The inspector offers only what applies: sound has no transform, a
  caption has no volume or speed. `tests/layout.spec.ts` says where
  each panel belongs and which tab it is behind, so a new one cannot
  quietly land in the wrong column or in two tabs at once.
- A waveform belongs to the SOURCE, not to the segment. Measure once
  per file and re-slice it for each block; never measure per segment.
  The request is not guarded by the generation counter, because a
  waveform is a property of the file rather than of what is currently
  on the timeline.
- Peaks are derived from the media and are not plain JSON, so they live
  in component state and never go near the store - the same split the
  source registry already makes for the files themselves.
- Only GENERIC font families are offered, and no font file is ever
  shipped or fetched. A named webfont would have to finish loading
  before the preview or the export could draw with it, and losing that
  race shows up as an export that does not match the preview. Generic
  families resolve everywhere, immediately, in both contexts.
- `fontStringFor` is the one place a caption becomes a CSS font, so the
  measuring and the drawing cannot disagree about the layout - which
  would put a background box in the wrong place.
- Every keyboard shortcut must stand down while a field has focus. A
  space typed into a caption is a space, not a play command.
- The autosave IS a draft: written with `toDraft`, read with
  `parseDraft`. One format and one validator, so an autosave left by an
  older build is handled by the same rules a file off disk is. Never
  add a second serialisation for it.
- Media is stored in IndexedDB as the File itself, keyed by sourceId -
  the same split the source registry already makes. A File survives
  IndexedDB whole, so a restored project needs no re-pick and shows no
  permission prompt. File-system handles would not: they exist only for
  files opened through the picker, and ours come from an input element.
- NOTHING may be autosaved until the restore has finished. For a moment
  after a reload the store holds the empty starting project, and a save
  fired then erases the very thing being restored. `tests/persistence`
  reloads, waits and reloads again to prove it does not.
- A draft file (`draft.ts`) is data off someone's disk: parse it field
  by field into a fresh object, never cast it. It carries no media, so
  reopening one leaves its sources offline until files are handed back.
  Opening a draft clears the undo history - undoing across it would
  walk into a timeline the user has closed.

- Every colour in the UI comes from a token in the two palettes at the top of
  `src/index.css`. There is exactly one hex outside them - the letterbox behind
  the picture, which stays `#000` in both themes because `renderFrame`
  composites onto black and a letterbox that followed the theme would disagree
  with the exported file. Adding a hex anywhere else silently breaks light
  mode; add a token instead.
- The theme is a preference about the EDITOR, so it lives in this browser and
  never travels in a draft (`tests/theme.spec.ts` pins that). Dark is the
  default rather than "follow the system": a bright surround makes footage look
  darker and flatter than it is. `src/ui/theme.ts` is the one place the
  "system" preference becomes a colour - the stylesheet knows only `dark` and
  `light`, so the light palette is never written out twice.

# Stack
Vite + React + TypeScript, pixi.js, mediabunny, zustand + immer
