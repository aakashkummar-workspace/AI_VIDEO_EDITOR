import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { loadEnv, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

/** Just enough of the agent module to call it; see src/assistant/agent.ts. */
type AgentModule = {
  runAgent: (input: {
    project: unknown
    request: string
    view?: unknown
    resumeSessionId?: string
  }) => Promise<{
    steps: unknown[]
    reply: string
    warning?: string
    costUsd?: number
    sessionId?: string
  }>
}

/** Just enough of the tool module; see src/assistant/tools.ts. */
type ToolModule = {
  dispatch: (
    project: unknown,
    name: string,
    args: Record<string, unknown>,
  ) => { project: unknown; step: unknown }
}

/** Where the page publishes the timeline, for anything outside to read. */
const LIVE_PROJECT_FILE = 'live/project.json'

/** Reads a JSON request body, or throws something worth reporting. */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    let body = ''
    request.on('data', (chunk: Buffer | string) => {
      body += chunk
    })
    request.on('end', () => done(body))
    request.on('error', fail)
  })
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(body))
}

/**
 * The live bridge: editing the timeline from outside the browser.
 *
 * Two halves. The page POSTs what the timeline is to `live/project.json`, so an
 * agent at a terminal can read it. And `POST /api/live/edit` takes tool calls,
 * runs them through the SAME `dispatch` the assistant uses - so an edit from
 * outside is not a new way to change a project, just a new way to ask - and
 * pushes the resulting steps down the dev socket for the page to apply.
 *
 * Dispatching here rather than in the caller is what keeps this usable: it
 * means whatever is outside speaks seconds and segment ids, and never has to
 * hand-build a mutator input in microseconds.
 */
/** Just enough of the watch module to call it; see src/assistant/watch.ts. */
type WatchModule = {
  watchFrames: (
    input: {
      durationMicros: number
      boundariesMicros: number[]
      frames: { atMicros: number; jpegBase64: string }[]
    },
    everySeconds: number,
  ) => Promise<unknown>
}

/**
 * Looking at the footage.
 *
 * The one endpoint that sends PICTURES to Anthropic. The transcriber is local
 * and the assistant otherwise sends only names and times, so this is the single
 * place a frame of somebody's video leaves the machine - which is why it is
 * behind its own deliberate verb and why the UI says so before it runs.
 *
 * It runs the model here rather than in the page for the same reason the
 * assistant does: the credential lives on this side.
 */
function watchBridge(apiKey: string): Plugin {
  return {
    name: 'assistant-watch',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/vision', (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'Send frames with POST.' })
          return
        }

        void (async () => {
          try {
            const body = JSON.parse(await readBody(request)) as {
              durationMicros?: number
              boundariesMicros?: number[]
              frames?: { atMicros: number; jpegBase64: string }[]
              everySeconds?: number
            }

            if (!body.frames || body.frames.length === 0) {
              sendJson(response, 400, { error: 'No frames were sent.' })
              return
            }

            if (apiKey) process.env['ANTHROPIC_API_KEY'] = apiKey

            const { watchFrames } = (await server.ssrLoadModule(
              '/src/assistant/watch.ts',
            )) as WatchModule

            const visuals = await watchFrames(
              {
                durationMicros: body.durationMicros ?? 0,
                boundariesMicros: body.boundariesMicros ?? [],
                frames: body.frames,
              },
              body.everySeconds ?? 2,
            )

            sendJson(response, 200, visuals)
          } catch (error) {
            sendJson(response, 500, {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        })()
      })
    },
  }
}

/**
 * The transcriber.
 *
 * Speech to text is the one thing Claude cannot do - it accepts no audio input
 * at all - so this runs a local Whisper instead. It is a sidecar on purpose:
 * the editor decodes the audio itself with WebCodecs and posts a plain WAV, so
 * the "no ffmpeg anywhere" rule the renderer lives under is not bent to reach
 * it, and the audio never leaves the machine.
 *
 * Slow WITHOUT A GPU, and that is the whole difference: on a CUDA card a minute
 * of speech takes seconds, and on a CPU it takes minutes. The sidecar tries the
 * GPU and falls back on its own, and reports which one it used - so a slow run
 * says why rather than just being slow. There is no timeout either way: cutting
 * one off halfway would waste the work and tell the user nothing.
 */
function transcribeBridge(model: string, device: string): Plugin {
  return {
    name: 'assistant-transcribe',
    configureServer(server: ViteDevServer) {
      const python = resolve(server.config.root, '.venv/Scripts/python.exe')
      const posixPython = resolve(server.config.root, '.venv/bin/python')
      const script = resolve(server.config.root, 'scripts/transcribe.py')

      server.middlewares.use('/api/transcribe', (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'Send audio with POST.' })
          return
        }

        const runner = existsSync(python)
          ? python
          : existsSync(posixPython)
            ? posixPython
            : null

        if (!runner) {
          sendJson(response, 503, {
            error:
              'The transcriber is not installed. Run: uv venv .venv && uv pip install --python .venv faster-whisper',
          })
          return
        }

        // Which language to expect, if the page pinned one. Auto-detection reads
        // the first few seconds, and on a quiet or accented opening it guesses
        // wrong - after which every word is transcribed as the wrong language.
        // Whitelisted to a code shape rather than passed through: this string
        // becomes an argument to a spawned process.
        const asked = new URL(
          request.url ?? '/',
          'http://localhost',
        ).searchParams.get('language')

        // 'mixed' is not a language. It asks for the detection to be redone for
        // every line, which is the only thing that reads speech that switches.
        const mixed = asked === 'mixed'
        const language =
          !mixed && asked && /^[a-z]{2,3}$/.test(asked) ? asked : null

        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          const wav = Buffer.concat(chunks)
          if (wav.length === 0) {
            sendJson(response, 400, { error: 'No audio was sent.' })
            return
          }

          const child = spawn(
            runner,
            [
              script,
              '--model',
              model,
              '--device',
              device,
              ...(language ? ['--language', language] : []),
              ...(mixed ? ['--multilingual'] : []),
            ],
            { cwd: server.config.root },
          )

          let out = ''
          let err = ''
          child.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString()
          })
          child.stderr.on('data', (chunk: Buffer) => {
            err += chunk.toString()
          })

          child.on('error', (error) => {
            sendJson(response, 500, {
              error: `Could not start the transcriber: ${error.message}`,
            })
          })

          child.on('close', (code) => {
            // The script reports its own failures as JSON, so a body is
            // preferred over the exit code wherever there is one.
            try {
              const parsed = JSON.parse(out.trim())
              sendJson(response, parsed.error ? 500 : 200, parsed)
            } catch {
              sendJson(response, 500, {
                error:
                  // The tail of stderr rather than all of it: a Python
                  // traceback is mostly frames, and the part that says
                  // what went wrong is at the end.
                  err.trim().slice(-400) ||
                  `The transcriber exited with code ${code}.`,
              })
            }
          })

          child.stdin.write(wav)
          child.stdin.end()
        })
      })
    },
  }
}

function liveBridge(): Plugin {
  return {
    name: 'assistant-live-bridge',
    configureServer(server: ViteDevServer) {
      const projectPath = resolve(server.config.root, LIVE_PROJECT_FILE)

      // What the page last told us the timeline is. Held in memory as well as
      // on disk so an edit does not depend on a file read racing a write.
      let published: unknown = null

      // WHICH page told us. The socket reaches every page connected to this
      // server, so an edit has to be addressed or they all apply it.
      let publishedBy: string | undefined

      server.middlewares.use('/api/live/project', (request, response) => {
        // Readable as well as writable, so whatever is outside can check what
        // the server actually holds rather than racing a file write.
        if (request.method === 'GET') {
          if (published === null) {
            sendJson(response, 404, {
              error: 'The editor has not published a timeline yet.',
            })
            return
          }
          sendJson(response, 200, published)
          return
        }

        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'Publish with POST.' })
          return
        }

        void (async () => {
          try {
            const body = await readBody(request)
            const incoming = JSON.parse(body) as {
              clientId?: string
              project?: unknown
            }

            // Older shape: the project on its own. Kept working so a page that
            // has not reloaded yet still publishes something readable.
            published =
              incoming && 'project' in incoming ? incoming.project : incoming
            publishedBy = incoming?.clientId
            mkdirSync(dirname(projectPath), { recursive: true })
            writeFileSync(projectPath, JSON.stringify(published, null, 1))
            sendJson(response, 200, { ok: true })
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        })()
      })

      server.middlewares.use('/api/live/edit', (request, response) => {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'Ask for an edit with POST.' })
          return
        }

        void (async () => {
          try {
            const { calls, note } = JSON.parse(await readBody(request)) as {
              calls: { tool: string; args: Record<string, unknown> }[]
              note?: string
            }

            if (!Array.isArray(calls) || calls.length === 0) {
              sendJson(response, 400, { error: 'Send at least one call.' })
              return
            }

            if (published === null) {
              sendJson(response, 409, {
                error:
                  'The editor has not published a timeline yet. Open the app in a browser first.',
              })
              return
            }

            const { dispatch } = (await server.ssrLoadModule(
              '/src/assistant/tools.ts',
            )) as ToolModule

            // Applied to a scratch copy here exactly as the assistant does, so
            // a call that the timeline would refuse fails HERE, with the
            // operation's own message, rather than silently in the page.
            let scratch: unknown = published
            const steps: unknown[] = []
            for (const call of calls) {
              const outcome = dispatch(scratch, call.tool, call.args ?? {})
              scratch = outcome.project
              steps.push(outcome.step)
            }

            server.ws.send({
              type: 'custom',
              event: 'assistant:live-plan',
              data: { steps, note, forClient: publishedBy },
            })

            sendJson(response, 200, { steps })
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        })()
      })
    },
  }
}

/**
 * The assistant's half of the server.
 *
 * Whatever credential is used lives HERE rather than in the page. A browser
 * cannot hide a secret from the document it runs in, so the agent runs on this
 * side and the page only ever posts a project and reads back a plan.
 *
 * It is a dev-server middleware because that is what this project has: there is
 * no backend, media never leaves the machine, and `npm run dev` is how the app
 * and the whole browser suite already run.
 *
 * NO KEY IS REQUIRED HERE, and that is not an oversight - it is what makes this
 * a LOCAL TOOL rather than a feature. The Agent SDK falls back to whatever
 * Claude Code on this machine is signed in with, so on a developer's own
 * machine it runs on their subscription. Anthropic's terms do not allow a
 * shipped product to do that, so anything deployed has to supply a real
 * ANTHROPIC_API_KEY and this endpoint has to be hosted somewhere. See CLAUDE.md.
 */
function assistantBridge(apiKey: string): Plugin {
  return {
    name: 'assistant-bridge',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/assistant/plan', (
        request: IncomingMessage,
        response: ServerResponse,
      ) => {
        const send = (status: number, body: unknown) => {
          response.statusCode = status
          response.setHeader('content-type', 'application/json')
          response.end(JSON.stringify(body))
        }

        if (request.method !== 'POST') {
          send(405, { error: 'Ask for a plan with POST.' })
          return
        }

        let body = ''
        request.on('data', (chunk: Buffer | string) => {
          body += chunk
        })

        request.on('end', () => {
          void (async () => {
            try {
              const {
                project,
                request: asked,
                view,
                sessionId,
              } = JSON.parse(body)

              // The Agent SDK reads the key from the environment of the
              // process it runs in, and ours came out of .env rather than the
              // shell. Set only when there IS one: an empty value reads as a
              // credential that is present and broken, where absent lets the
              // SDK fall back to whatever this machine is signed in with.
              if (apiKey) process.env['ANTHROPIC_API_KEY'] = apiKey

              // Loaded through Vite so the server runs the SAME agent module
              // the unit tests cover, rather than a compiled copy that could
              // drift from it.
              const { runAgent } = (await server.ssrLoadModule(
                '/src/assistant/agent.ts',
              )) as AgentModule

              const outcome = await runAgent({
                project,
                request: asked,
                view,
                resumeSessionId: sessionId,
              })

              send(200, {
                steps: outcome.steps,
                reply: outcome.reply,
                warning: outcome.warning,
                costUsd: outcome.costUsd,
                sessionId: outcome.sessionId,
              })
            } catch (error) {
              send(500, {
                error: error instanceof Error ? error.message : String(error),
              })
            }
          })()
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // The third argument is '' so that a key with no VITE_ prefix is read. That
  // prefix is exactly what would expose it to the browser, which is the one
  // thing this must not do.
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      react(),
      assistantBridge(env['ANTHROPIC_API_KEY'] ?? ''),
      liveBridge(),
      watchBridge(env['ANTHROPIC_API_KEY'] ?? ''),
      transcribeBridge(
        env['WHISPER_MODEL'] ?? 'medium',
        // `auto` tries the GPU and falls back. There is a WHISPER_DEVICE=cpu
        // for the case a GPU is present but wanted for something else.
        env['WHISPER_DEVICE'] ?? 'auto',
      ),
    ],
    // Stop Vite searching parent directories for a PostCSS config. Without this
    // it picks up C:\Users\Welcome-Pc\postcss.config.js (Tailwind + autoprefixer),
    // which has nothing to do with this project.
    css: { postcss: {} },
    test: {
      // tests/ holds the Playwright browser suite; vitest only runs unit tests.
      include: ['src/**/*.test.ts'],
    },
  }
})
