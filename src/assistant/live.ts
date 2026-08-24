/**
 * The other way in: editing the timeline from outside the browser.
 *
 * An agent working at a terminal - Claude Code, a script, anything - cannot
 * reach into a page. So the page does two things instead. It PUBLISHES what the
 * timeline currently is, so whatever is outside can read it and decide what to
 * ask for; and it LISTENS for plans, which arrive over the dev server's own
 * socket and are applied exactly as an approved plan from the assistant column
 * is: through `applyPlan`, in one undo step.
 *
 * Steps arrive rather than whole projects, and that is the important choice.
 * Replacing the project would work, but it would clear the undo history on
 * every edit and hand back a timeline whose media had to be relinked. Steps
 * leave both alone.
 *
 * This is a development-time bridge. It exists only where `import.meta.hot`
 * does, which is to say under `npm run dev` and nowhere else - a built copy of
 * the application has no socket and no server to publish to.
 */

import type { PlanStepInput } from '../timeline/store'

/** Where the page publishes what the timeline currently is. */
export const PUBLISH_ENDPOINT = '/api/live/project'

/** The socket message a plan arrives on. */
export const LIVE_PLAN_EVENT = 'assistant:live-plan'

/**
 * Which page this is.
 *
 * The server holds one timeline and the socket reaches every page connected to
 * it - a second tab, or the browser suite running against the same dev server.
 * Without an address, an edit meant for one of them is applied by all of them,
 * which is how a test once wrote a caption into somebody's real project.
 *
 * An edit is dispatched against whatever was published last, so the page that
 * published it is the page the edit belongs to. This is how it says which one
 * that was.
 */
export const CLIENT_ID = crypto.randomUUID()

export type LivePlan = {
  steps: PlanStepInput[]
  /** What to say happened, for the transcript. */
  note?: string
  /** The page this was meant for. Anything else must ignore it. */
  forClient?: string
}

/**
 * How long to wait before publishing again.
 *
 * A drag fires a store update per mouse move, and writing a file per frame of a
 * drag would be pointless. A quarter of a second is far below noticing and far
 * above the rate anything outside can usefully read.
 */
const PUBLISH_DELAY_MS = 250

let timer: ReturnType<typeof setTimeout> | undefined
let latest: unknown

function post(project: unknown): void {
  void fetch(PUBLISH_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, project }),
  }).catch(() => {
    // Nothing is listening, which is the normal case.
  })
}

/**
 * Publishes the project.
 *
 * The FIRST change in a quiet spell goes out immediately, and only the ones
 * behind it wait. Debouncing everything would mean a quarter of a second after
 * every edit in which the published timeline is a lie - and something outside
 * reading it then would plan against a project that no longer exists.
 *
 * Failures are swallowed on purpose: the editor must work with nothing
 * listening, and a dev server that has gone away is not something to interrupt
 * somebody's edit over.
 */
export function publishProject(project: unknown): void {
  if (!import.meta.hot) return

  latest = project

  if (timer === undefined) {
    post(latest)
    // Held open for the delay so that a drag, which fires per mouse move, gets
    // one trailing publish rather than one per frame.
    timer = setTimeout(() => {
      timer = undefined
      post(latest)
    }, PUBLISH_DELAY_MS)
    return
  }

  clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    post(latest)
  }, PUBLISH_DELAY_MS)
}

/**
 * Calls back whenever a plan arrives from outside. Returns the unsubscribe, and
 * a no-op outside development.
 */
export function onLivePlan(handler: (plan: LivePlan) => void): () => void {
  const hot = import.meta.hot
  if (!hot) return () => {}

  const listener = (data: LivePlan) => {
    // Arrives off a socket, so it is data rather than something to trust: a
    // malformed plan must read as "nothing to apply", not throw inside a
    // listener where nobody would see it.
    if (!data || !Array.isArray(data.steps) || data.steps.length === 0) return

    // Addressed to another page - a second tab, or a browser running the test
    // suite against this same dev server. Applying it here would edit a project
    // nobody asked about.
    if (data.forClient !== undefined && data.forClient !== CLIENT_ID) return

    handler(data)
  }

  hot.on(LIVE_PLAN_EVENT, listener)
  return () => {
    hot.off(LIVE_PLAN_EVENT, listener)
  }
}
