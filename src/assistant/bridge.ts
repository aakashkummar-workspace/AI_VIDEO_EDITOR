/**
 * How the browser asks for a plan.
 *
 * The page holds no credentials. It posts the project and the request to the
 * dev server, which has the key, talks to Claude and sends back the plan - so
 * the one secret involved never enters a document that scripts can read.
 *
 * That is also why the planning loop runs on the server rather than here: the
 * loop is what holds the key, and moving it out of the page is the entire
 * point. `plan.ts` is the same module either side; only who calls it changed.
 */

import type { PlanStep } from './tools'
import type { ProjectView } from './describe'

/** Where the dev server listens. Relative, so it follows whatever host serves the page. */
export const PLAN_ENDPOINT = '/api/assistant/plan'

export type BridgeOutcome = {
  steps: PlanStep[]
  reply: string
  warning?: string
  /** What the run cost, as the agent reported it. Absent if it did not say. */
  costUsd?: number
  /**
   * The agent's session. Sent back on the next request so a follow-up like
   * "now make it shorter" has the earlier turns to refer to.
   */
  sessionId?: string
}

/**
 * The shape the server sends when it cannot help. Kept separate from a thrown
 * error so that "nobody has configured a key" reads as a setup instruction
 * rather than as a crash.
 */
type BridgeError = { error: string }

export async function requestPlan(input: {
  project: unknown
  request: string
  view?: ProjectView
  /** The session to continue, from the last outcome. */
  sessionId?: string
  signal?: AbortSignal
}): Promise<BridgeOutcome> {
  const response = await fetch(PLAN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      project: input.project,
      request: input.request,
      view: input.view,
      sessionId: input.sessionId,
    }),
    signal: input.signal,
  })

  // A body is expected either way: the server answers a refusal with a reason,
  // and losing that to a bare status code would leave nothing to act on.
  const body = (await response.json().catch(() => null)) as
    | BridgeOutcome
    | BridgeError
    | null

  if (!response.ok || body === null || 'error' in body) {
    throw new Error(
      body && 'error' in body
        ? body.error
        : `The assistant could not be reached (${response.status}).`,
    )
  }

  return body
}
