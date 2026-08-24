/**
 * What the assistant asks for, and of which model.
 *
 * The client itself is built on the SERVER (see the bridge plugin in
 * `vite.config.ts`), because that is where the key is. Only the choices that
 * describe the request live here, so the planning loop and the server agree
 * about them without the loop knowing how the client was made.
 */

/**
 * Opus is the one worth using here: the edits look irreversible to a nervous
 * user, and a plan that misreads the timeline costs more trust than the tokens
 * save.
 */
export const ASSISTANT_MODEL = 'claude-opus-5'

/** How much room a reply gets. Plans are short; this is headroom, not a target. */
export const ASSISTANT_MAX_TOKENS = 16_000
