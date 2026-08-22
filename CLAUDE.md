# Video Editor - architecture rules

- ONE render function. `renderFrame(state, timeMs)` is used by
  BOTH the preview and the export. Never write a second one.
- All video decoding happens in a Web Worker. Main thread = UI only.
- Every VideoFrame object must be .close()'d after use.
  Leaking them will crash the browser tab.
- Timeline state is plain JSON. No class instances, no GPU objects.
- All time values are integers in MICROSECONDS. Never seconds,
  never floats.
- Do not add a feature without a test.

# Stack
Vite + React + TypeScript, pixi.js, mediabunny, zustand + immer
