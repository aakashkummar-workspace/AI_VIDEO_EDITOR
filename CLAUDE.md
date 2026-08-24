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
- SECOND EXCEPTION, and the last one: the assistant speaks SECONDS,
  both in the outline it is shown (`assistant/describe.ts`) and in the
  arguments it sends (`assistant/tools.ts`). A model emits 4.5 far more
  reliably than it emits 4500000, and the cost of getting that wrong is
  an edit in the wrong place. Both directions go through the same
  `secondsToMicros` / `microsToSeconds` the sink uses, at the tool
  boundary, so a float second still never travels further in than the
  call site. Do not add a third.
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
- A SOURCE'S `rotation` AND A SEGMENT'S `rotation` ARE DIFFERENT THINGS. The
  first is metadata the camera wrote, honoured by `drawFrame` before anybody has
  said anything; the second is what somebody ASKED for on top of it. Footage
  that has been through a messaging app arrives with its orientation already
  baked in wrong and nothing in its metadata to fix, so turning it by hand has
  to be possible. Rotation is an ordinary animatable property - a value read AT
  a time - so it keyframes, inspects and reaches the agent by the same rules as
  scale and opacity, and is clamped to a single turn either way because more
  would only ever mean the same picture.
- ROTATION AND SCALE SHARE AN ORIGIN in `withTransform`, and are applied
  together, or a clip that is both turned and scaled orbits its own corner
  instead of staying put. The whole block is still skipped when both are
  identity, which is what keeps an untransformed segment byte for byte what it
  was.
- A TURNED PICTURE OCCLUDES NOTHING. `occludesEverything` refuses every non-zero
  rotation rather than reasoning about which angles still fill the frame: a
  quarter turn only covers again if the composition is square, and the corners
  show through at every other angle. The answer that cannot be subtly wrong is
  worth more here than the one that is occasionally tighter.
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
- THE EDITOR RE-RENDERS SIXTY TIMES A SECOND WHILE PLAYING, because the
  playhead lives in its state and the player reports every frame. That is fine
  for what DRAWS the playhead and ruinous for everything else, so anything
  expensive in that path has to be kept out of it. `silenceTrim` walks every
  peak of a source and is memoised for exactly this reason - on a three minute
  recording it was ten thousand comparisons a frame to answer a question whose
  answer had not changed. The assistant column takes the playhead as a REF and
  sits behind a memo: it shows none of that number, it only reads it when a
  request is sent.
- BEFORE AND AFTER IS A PROJECT, NOT A MODE. The "before" picture is built as
  an ordinary project - one source, whole, at the head, in the SAME composition -
  and handed to the player like any other, so it goes through the one render
  function with everything else. A special case in the player would be a second
  way to draw a picture, which is the thing this codebase spends its life
  avoiding.
- IT IS A TOGGLE, NOT TWO PICTURES SIDE BY SIDE. The second picture would mean
  decoding the source a second time, concurrently, and a phone recording is
  expensive enough to decode once. It also belongs with the TRANSPORT rather
  than with the verbs: pressing it changes nothing about the project, the
  timeline underneath goes on showing the cut, and the undo history is
  untouched - `tests/compare.spec.ts` pins all three.
- THE PREVIEW SURFACE IS CAPPED, the export is not. A phone now records
  2160x3840, which is eight and a half megapixels sixty times a second drawn
  into a canvas a few hundred pixels wide - almost all of it thrown away by the
  browser scaling it down to fit. `previewSize.ts` caps the longest side at
  1920 and `paint` scales its context ONCE, which is the same mechanism the
  export already uses for a different output size: renderFrame never learns the
  surface size, so a smaller preview can only be the same picture drawn
  smaller. The cap is not a quality setting - 1080p and everything under it,
  which is every committed fixture, is drawn at its own size and never
  resampled. The EXPORT still writes at full size, which is what keeps the
  golden-frame comparison meaningful.
- CAPPING THE PREVIEW DOES NOT MAKE 4K60 DECODE IN REAL TIME. It removes the
  compositing cost, not the decoding cost, and `BUFFER_AHEAD_MICROS` is 400ms
  against a `BUFFER_MAX_FRAMES` of 24 - which at 60fps is exactly 400ms, so the
  two bounds coincide and there is no slack left at all. The seek measurements
  this file quotes are synthetic H.264; nobody has measured sustained 4K60.
  Measure before raising either bound, and remember 24 frames at 4K is already
  about 300MB.
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
- There is a FOURTH zone, and only one: the assistant column, which is
  neither a noun nor a verb but a CONVERSATION about the project. It
  earns its own column because a request there is as likely to be about
  the whole timeline as about one clip, so neither existing column
  owns it. It is not a licence for a fifth: anything that is a fact
  about the project or the selection, or an action on either, still
  belongs in one of the three. `tests/layout.spec.ts` knows all four
  zones and fails a control that appears in two.
- The verbs in the strip run the SAME store operations the keyboard
  shortcuts do. A verb is a second way to reach an edit, never a second
  implementation of it, and never a place settings live: the transition
  verb applies one at the default length and the KIND stays a field.
- The assistant is a THIRD route to those same operations, under the
  same rule. Every tool in `assistant/tools.ts` names a mutator from
  `operations.ts`; none of them carries behaviour of its own. A tool
  that did anything the buttons cannot would be the second
  implementation this codebase has spent its whole life avoiding.
- The assistant PLANS, and applies nothing. A run is worked out against
  a scratch copy of the project - which is possible only because the
  timeline is plain JSON and every operation is a pure function of it -
  and the store sees nothing until somebody approves the result. The
  whole approved run then goes through `applyPlan` as ONE undo step,
  all of it or none: a decision somebody made once has to be one
  keystroke to take back, and half an applied plan leaves nothing
  sensible to point undo at.
- WHAT THE WORDS DO NOT SAY IS COMPUTED, NOT GUESSED. How CLEARLY a line was
  said, how LOUDLY, and whether it repeats an earlier one are three things an
  editor uses constantly and a transcript cannot carry - and between them they
  are most of what separates a rehearsal from a take, since somebody muttering a
  line before delivering it is quieter, less distinct, and about to repeat
  themselves. `signals.ts` works all three out with arithmetic. Asked to spot a
  rehearsal from text alone a model is guessing; handed those three it is
  reading. Same reasoning as `silence.ts`: compute what can be computed and
  spend the model on what cannot.
- THE SIGNALS TRAVEL AS FLAGS, AND ONLY WHEN TRUE. A clarity of 0.94 on every
  ordinary line is noise in the request and noise in the reading; what is worth
  sending is that this one is 0.41. `repeatOf` carries an index rather than a
  flag because the agent needs to know WHICH take it is a second attempt at -
  the later of a pair is almost always the keeper. Absent means NOT MEASURED,
  never "measured and fine": a file with no word timings has no clarity, and a
  zero there would read as "this was mumbled", which is a different claim.
- LOUDNESS IS RELATIVE TO THE MEDIAN LINE, not to full scale. An absolute level
  says more about the microphone and the room than about the delivery. And a
  repeat is scored by how much of the SHORTER line appears in the longer, not by
  how alike the two are overall: a rehearsal is very often an abandoned prefix
  of the real take, and a symmetric comparison scores that pair as unrelated.
- A TRANSCRIPT LINE IS NOT A CUT BOUNDARY. Whisper lines run several seconds
  and usually hold more than one sentence, so an agent given only lines can cut
  around a sentence but never to it. The WORD timings are sent for that, as
  `[start, end, word]` tuples rather than objects - there are thousands of them
  and every repeated key is paid for in the request. Past
  `WORD_TIMING_LIMIT_SECONDS` or `WORD_TIMING_LIMIT_WORDS` they are dropped and
  `wordsOmitted` is set: a long interview must not quietly make every question
  asked about it expensive, and an agent that is not told it lost the precision
  will assume it still has it.
- A WORD'S START IS WHERE THE SOUND BEGINS, so a cut placed on it clips the
  consonant and swallows the breath before it. `quietSpans` - the exact
  complement of `loudSpans`, derived from it rather than measured again - is
  sent alongside the words so a boundary can be put in the gap instead. That is
  the difference between a cut that sounds deliberate and one that sounds
  broken, and it is the same padding reasoning `DEFAULT_SILENCE_OPTIONS` already
  encodes for Trim silence.
- `ProjectView` is declared ONCE, in `describe.ts`, and imported by the
  component, the bridge and the agent. It was written out in all three, and a
  field added to the outline had to be added to three copies of a type before it
  could reach one. Everything in it is derived from media or from what is on
  screen - never authored - which is exactly why none of it is in the project.
- CUTTING TO A TRANSCRIPT IS ONE OPERATION, NOT FORTY. `remove_spoken_ranges`
  takes a list of ranges in SOURCE seconds - the clock the transcript is already
  written in - and lands on `keepSourceSpans`, the same mutator Trim silence
  uses. Reaching the same result through splits and deletes cannot work: each
  split changes the ids and the times every later one needs, so a plan built
  that way is wrong from its second step. It is also the ONLY tool that speaks
  source time; every other one takes timeline seconds, and that asymmetry is the
  point - it is what spares a model the one conversion it is worst at.
- The model is asked what to REMOVE and the operation is told what to KEEP,
  because those are the two natural ways to say it and neither side should have
  to think in the other's. `keptSpans` inverts, and it merges overlapping cuts
  first: two lines of a transcript can share a moment, and `keepSourceSpans`
  would refuse the overlap that produced.
- `ranges` is the one compound field kind in `TOOL_SPECS`, and it is expanded by
  `jsonSchemaFor` on the way to the model and by `zodFor` on the way to the
  Agent SDK. Adding a second compound kind means adding it in both, and the
  drift test in `tools.test.ts` compares every field through the converter
  rather than by identity so it cannot be added to only one.
- THE AGENT CAN ASK AS WELL AS ACT, and `read_back` and `check_cuts` are the
  only two tools that name no mutator. They are in `inspect.ts` rather than
  `tools.ts` for exactly that reason, and `agent.test.ts` pins that nothing
  appears in both lists. They are not a loophole for a second implementation of
  an edit: they change nothing, they read the SCRATCH project, and an agent that
  used them to compute an edit would still have to go through the same
  eighteen mutators to make it.
- AN EDIT THE AGENT HAS NOT READ IS AN EDIT IT HAS NOT CHECKED. It used to plan
  entirely blind - it knew what it had asked for and what the timeline was
  beforehand, and could never look at what it made, which is the difference
  between cutting TO a script and cutting at numbers taken from one.
  `read_back` maps the transcript through the segments as they now stand, so a
  sentence left in halves is visible; `check_cuts` turns "does this boundary
  land inside a word" from something a model reasons about into something it
  looks up. The instructions require both, in that order, around every cut.
- `timelineMicrosFor` IS SHARED between `captions.ts` and `inspect.ts` rather
  than written twice. Two functions mapping source time onto the timeline would
  eventually disagree, and the disagreement would surface as a caption in one
  place and a cut in another.
- Ids handed to the model are MINTED, never accepted. Split, duplicate,
  add-text and add-effect all take a caller-supplied id; a model cannot
  see the ids already in use, so one it invented would collide sooner
  or later. They are in no tool schema.
- A tool result reports the project as it IS afterwards, not what was
  asked for. Trims clamp silently, and transitions, duplicates and rate
  changes move segments other than the one named - so echoing the
  request back would have the model plan its next step on a fiction.
  Each step therefore carries two readings: `summary` for the model,
  which needs ids, and `label` for the person approving it, which must
  not have any in it.
- THE AGENT IS THE CLAUDE CODE AGENT SDK, running server-side, with the
  eighteen operations handed to it as an in-process MCP server built
  from `TOOL_SPECS`. The schemas are DERIVED from those specs, never
  written out again, so the agent cannot be offered an operation the
  application does not have. Its built-in tools are switched off and
  `settingSources` is emptied: a video editor has no business handing
  out Read, Edit or Bash, and it must not pick up this repository's own
  CLAUDE.md and start behaving like a coding assistant.
- WHATEVER CREDENTIAL IS USED LIVES ON THE SERVER. A page cannot keep a
  secret from itself, so the browser posts a project and reads back a
  plan. `ANTHROPIC_API_KEY` goes in `.env`, deliberately without a
  `VITE_` prefix, because that prefix is exactly what would hand it to
  the page.
- THE IN-APP AGENT IS A LOCAL TOOL, NOT A SHIPPABLE FEATURE, and the
  distinction is deliberate. With no key configured, the Agent SDK falls
  back to whatever Claude Code on this machine is signed in with - so on
  a developer's own machine it runs on their subscription and costs
  nothing. Anthropic's terms do not permit a third-party product to do
  that. Anything deployed must supply a real API key and host this
  endpoint itself. Do not "fix" the missing key check: its absence is
  the documented behaviour, and this note is why.
- The LIVE BRIDGE is the legitimate way to spend a subscription on this,
  and the difference is WHO IS THE AGENT. There, Claude Code is the
  agent and the application merely receives tool calls; here, the
  application is the agent and is borrowing a login meant for a person.
- The assistant suite NEVER calls a real model. `tests/assistant.spec.ts`
  stubs the bridge; a suite that called out would flake on the weather
  and bill somebody for it. The half that turns a tool call into a real
  edit is tested without a browser instead.
- WHERE THE SHOTS CHANGE HAS NO MODEL IN IT, exactly as where the silence is
  has none. `shots.ts` compares an 8x8 grid of brightnesses per sampled frame
  and answers from arithmetic: one right answer, no cost, and the same answer
  every run. What a model is for is what is IN the shot, which is `watch.ts`.
  The boundaries are computed BEFORE the model is asked and handed to it, so it
  is only ever asked the question it alone can answer - the same division
  `silence.ts` makes against the transcriber.
- THE GRID IS MEASURED IN THE WORKER, while the frame is decoded and already on
  a canvas, and only the numbers come back. That is what keeps `shots.ts` pure
  and testable without a browser, and it means the pictures never have to be
  held to answer where a cut is. Luma is Rec. 601 weighted: an unweighted
  average would call a blue shot and a green one equally bright.
- LOOKING SENDS PICTURES TO ANTHROPIC, and it is the only thing in the
  application that sends footage anywhere - the transcriber is local, and the
  assistant otherwise sends names and times. That is why it is behind its own
  deliberate verb, why the verb says so in as many words before it is pressed,
  and why nothing triggers it automatically. Never make Watch implicit.
- A DESCRIPTION IS SAMPLED, NOT WATCHED. A frame every `VISION_SAMPLE_SECONDS`
  catches anything a person would call a shot and nothing finer, so a boundary
  from `visuals` is accurate to about that and never to the frame. When a script
  is present too, the WORDS are the precise clock and the shots decide what to
  cut - the agent is told exactly that. Past `VISION_MAX_FRAMES` the sampling
  stops and `truncatedAfterSeconds` says where, because an agent told nothing
  reads a description as covering the whole film.
- A SEGMENT'S KIND DOES ANSWER WHETHER THERE IS A PICTURE, which is the opposite
  of the sound case: a video segment always has frames, where a video file may
  well have no audio. So `selectedCanWatch` reads the kind and the source's
  width - zero being what a piece of music honestly stores - while Transcribe
  still has to read the waveform.
- SPEECH TO TEXT IS A LOCAL SIDECAR, and it has to be: Claude accepts no
  audio input at all, so no amount of prompting gets a transcript out of
  it. `scripts/transcribe.py` runs faster-whisper behind
  `/api/transcribe`, and the audio never leaves the machine.
- THE EDITOR DECODES THE AUDIO, NOT THE SIDECAR. The worker decodes with
  WebCodecs and resamples to 16kHz mono; what is posted is a plain PCM
  WAV. That is what keeps the "no ffmpeg anywhere" rule intact - a
  transcriber handed an MP4 would need a demuxer, and that is the door
  this refuses to open.
- WHISPER GETS STUCK, and the transcript has to be defended from it twice. A
  phrase said twice makes itself the likeliest next thing, and the model emits
  it three hundred times; it is worst in languages the model knows least well.
  `scripts/transcribe.py` decodes with `condition_on_previous_text=False` - the
  carry-over between windows IS the feedback loop - plus `no_repeat_ngram_size`
  and a temperature fallback list, and `dropRunawayRepeats` in `transcript.ts`
  collapses what still gets through. The two are not redundant: the decoder
  works one 30-second window at a time and cannot see a loop spanning several.
  Never widen `LOOP_REPEATS` to make some real speech survive - three
  consecutive identical phrases is not something anybody says, and a transcript
  that admits it heard one thing is worth more than one that invents a minute of
  speech to cut against.
- THE SPOKEN LANGUAGE CAN BE PINNED, because auto-detection reads the first few
  seconds and a quiet or accented opening makes it guess wrong - after which
  every word comes back as a language nobody spoke. It is a preference about
  this BROWSER, like the theme, so it lives in `assistant/language.ts` and never
  travels in a draft. `medium` is the right model for English; for Tamil, Hindi
  or Japanese set `WHISPER_MODEL=large-v3` in `.env` and accept the slowness.
- MIXED IS NOT A LANGUAGE, and that is why the preference is a string rather
  than a language code. Speech that switches - Tamil with English words dropped
  into it, a bilingual interview - is read wrong by both alternatives: pinning
  one language mangles half the words, and detecting once at the top commits
  the whole file to whatever the opening happened to be in. `MIXED` asks the
  sidecar for `multilingual=True`, which decides again for every line. It is
  per LINE, not per word, so a sentence that switches halfway is still resolved
  one way - a limit of the model, not something to work around here.
- TRANSCRIBE IS ALWAYS OFFERED once a file has sound in it, even after an
  answer. A wrong language or a loop is the whole reason anybody presses it
  twice, and a button that went dead on its first answer would strand them with
  it. It is the one verb in the strip beside a setting - the language, which
  sits in the assistant column because it governs the SCRIPT, which is there,
  and because it is not a fact about the selection: changing it says nothing
  about the clip, only about what to listen for next.
- THE SIDECAR TRIES THE GPU AND FALLS BACK ON ITS OWN. Measured on this
  machine, an RTX 3050: 60 seconds of audio through `medium` takes 1.0s on CUDA
  against 8.3s on eight CPU threads. The fallback is not optional - a missing
  CUDA library is not something a person editing a video did wrong, and words
  arriving slowly beat an error - but it must stay VISIBLE, which is what
  `device` in the result is for. A transcription that quietly dropped to the CPU
  is indistinguishable from a long one.
- CUDA FAILS AT TWO SEPARATE MOMENTS, which is why the fallback wraps the whole
  attempt rather than the model load. `WhisperModel(device='cuda')` succeeds
  with the libraries missing; `cublas64_12.dll is not found` is raised at the
  first inference. faster-whisper decodes lazily, so the segments are
  materialised inside the try or the error is raised outside it.
- ON WINDOWS THE CUDA DLLS ARE FOUND THROUGH `PATH`, not through
  `os.add_dll_directory` - that only covers loads made with the newer search
  flags, and ctranslate2 does not use them. `nvidia` is a NAMESPACE package, so
  it has `__path__` and no `__file__`. Both are set in `enable_cuda_libraries`,
  and it runs BEFORE `faster_whisper` is imported: ctranslate2 resolves CUDA at
  import time, and a PATH set afterwards is set too late.
- A TRANSCRIPT BELONGS TO THE SOURCE, exactly as the waveform does, and
  is measured in SOURCE seconds. Split a clip and both halves are
  covered by the one transcript, re-sliced. Like the peaks it is derived
  from media rather than authored, so it lives in component state, never
  in the store, and never travels in a draft.
- CAPTIONS ARE MAPPED THROUGH THE SEGMENT THAT PLAYS THEM, in
  `captions.ts`. Source time is not timeline time: a clip playing source
  10s-20s at timeline 5s puts source 12s at timeline 7s, and a line
  spoken in a part nobody kept simply does not appear. A whole caption
  pass is ONE undo step, because captioning an interview is one
  decision.
- A SEGMENT'S KIND DOES NOT MEAN THE FILE HAS SOUND. `soundContent` says
  only that a segment is the kind that could carry audio; a video shot
  with the microphone off is still a video segment. The WAVEFORM is the
  honest answer, and it is already measured - which is what the
  Transcribe verb reads before offering itself.
- TRIMMING SILENCE HAS NO MODEL IN IT. Where somebody stopped talking is a
  question about loudness: it has one right answer, and `silence.ts`
  computes it from the peaks the worker already measures. A model would
  be slower, cost money and disagree with itself between runs. What a
  model would be for is deciding which WORDS to cut, and that needs a
  transcript - Claude cannot help there either, because it accepts no
  audio input at all.
- The DECISION and the EDIT are separate, and have to be. `silence.ts`
  is pure arithmetic over peaks and knows nothing about the project;
  `keepSourceSpans` takes the spans and knows nothing about waveforms.
  Peaks are derived from media and never enter the store, so an
  operation that measured its own audio would have to reach outside the
  project to do it.
- `keepSourceSpans` lays the kept parts END TO END and pulls what
  follows earlier, so the sound is continuous rather than pockmarked
  with the gaps that were removed. Only the first piece keeps a
  transition: the rest begin at a cut it just made, with nothing behind
  them to blend from.
- No committed fixture contains silence - they are continuous tones - so
  the browser suite can only prove that the verb DECLINES when there is
  nothing to cut. The cutting itself is proved in `silence.test.ts` and
  in the `keepSourceSpans` tests. Adding a fixture with real pauses is
  the way to close that, and it has to be encoded by `npm run fixture`
  in a real browser like every other one.
- There is a SECOND way in, for an agent outside the browser: the page
  publishes the timeline to `/api/live/project` and listens for plans on
  the dev socket (`assistant/live.ts`). It carries STEPS, never whole
  projects - swapping the project in would clear the undo history on
  every edit and leave the media to be relinked, which is not what an
  edit does. `tests/live-bridge.spec.ts` drives the real endpoints,
  because a stubbed bridge would prove nothing.
- The live bridge takes TOOL CALLS and dispatches them server-side, so
  a caller speaks seconds and segment ids and never hand-builds a
  mutator input. It needs no key and no model: that is what makes it
  usable on a machine with no API credits. It is a development-time
  thing - it exists only where `import.meta.hot` does.
- WHAT IS PUBLISHED GOES OUT ON THE FIRST CHANGE, and only the ones
  behind it wait. Debouncing everything leaves a window in which the
  published timeline is a lie, and something outside reading it then
  plans against a project that no longer exists.
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
- `setProject` CLOSES DECODERS, IT DOES NOT DROP FILES, and the distinction only
  became load-bearing once there was more than one project. Switching sends a
  project whose sources are all different, so dropping the files there left the
  project being LEFT with nothing to decode from the moment somebody came back
  to it - and the main thread still had the file, so `hasSourceFile` was true,
  the relink panel never offered itself, and what surfaced was a raw worker
  error with a uuid in it. A File is a lazy handle rather than the bytes; the
  decoder is what was expensive, and that still goes.
- A FILE TOO BIG TO STORE IS STILL USABLE. A phone recording can be larger than
  the whole quota, so `saveMedia` failing is not rare and must not be silent:
  it is said out loud, and reopening a project falls back to whatever this
  SESSION already has open before giving up on a source. The failure otherwise
  surfaces hours later, on the next visit, as a timeline with nothing behind it.
- THERE ARE MANY PROJECTS, each under its own id in the project store. WHICH
  one is open is a preference about this BROWSER - two tabs may reasonably have
  different work open - so it lives in localStorage beside the theme and the
  spoken language, and never enters a draft. The NAME is part of the work and
  goes in the draft envelope beside the project, NOT inside it: nothing renders
  differently for being called anything, and `parseDraft` would otherwise have
  to validate a name as though a frame depended on it.
- SWITCHING PROJECTS IS SYNCHRONOUS, and the writes happen after it. Creating a
  project touches the database, and awaiting that BEFORE swapping the state
  leaves a window in which the new project is notionally open while the name
  field still belongs to the old one - a name typed into it is then wiped when
  the write finishes. `createProject` captures the outgoing project, swaps
  everything, and only then writes.
- THE OUTGOING PROJECT IS KEPT ON THE WAY OUT, because the autosave is debounced
  and work edited then left inside that window has never been written. An EMPTY
  one is deliberately not kept: an untouched editor is not work, and saving it
  would put a blank project in the list every time somebody pressed New and make
  a fresh browser look like it already had something in it. `tests/persistence`
  pins that a fresh browser has nothing saved.
- DELETING A PROJECT LEAVES THE MEDIA. A file can be in more than one project
  and there is no way to know from the store whether it is, so removing it
  would take a clip out of a project nobody asked about. Unused bytes are the
  cheaper mistake. The MEASURED data is keyed by source too, which is why
  switching projects keeps a transcript somebody has already paid for.
- THE OLD SINGLE SLOT IS ADOPTED, NOT ABANDONED. A browser last used before
  names existed has one project under `LEGACY_SLOT`, and it is somebody's work:
  `adoptLegacyProject` gives it an id on first read. That constant outliving the
  feature that replaced it is the point of it.
- WHAT WAS MEASURED IS KEYED BY THE FILE, NOT BY THE IMPORT. A sourceId is
  minted per import, so the same footage brought into a second project has a
  second one - which is right for the timeline, since the two projects trim it
  differently, and wrong for everything derived from the bytes. `mediaKey.ts`
  identifies the file by size, modified time and name; hashing 400MB would take
  seconds before the editor could even say whether it knew the file, and the
  case being guarded against is somebody re-importing their own footage rather
  than somebody forging a collision. The agent speaks source ids, so
  `knowledgeForAssistant` is the ONE place the two keyings are crossed.
- REMOVING A SOURCE LEAVES WHAT WAS MEASURED FROM IT. Another project may be
  playing the same file under a different sourceId, and the transcript cost
  minutes of somebody's machine. A few kilobytes outliving their last user is
  much the cheaper mistake.
- WHAT WAS MEASURED IS KEPT, in a THIRD IndexedDB store keyed by that file key. A
  transcript and a shot description are still derived rather than authored, so
  they are still out of the store and still absent from a draft - but that was
  never a reason to recompute them on every reload. A transcript costs minutes
  of somebody's machine and a description costs real money, where the peaks
  beside them cost milliseconds, which is why those two are kept and the peaks
  are not. Without this the assistant goes blind after every reload and rightly
  refuses to cut, which is exactly how the gap was found.
- The measured store is written READ-MODIFY-WRITE. Transcribing and looking are
  separate acts on the same file and the same key, and whichever happens second
  must not erase the first. `persistence.ts` deliberately does not know what
  either of them looks like: it stores what it is handed and the caller parses
  what comes back, so an entry written by an older build is harmless.
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
