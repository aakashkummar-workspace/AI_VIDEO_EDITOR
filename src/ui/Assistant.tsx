import { memo, useEffect, useRef, useState, type FormEvent } from 'react'
import { requestPlan, type BridgeOutcome } from '../assistant/bridge'
import { SPOKEN_LANGUAGES } from '../assistant/language'
import { onLivePlan, publishProject } from '../assistant/live'
import { useTimelineStore } from '../timeline/store'

/**
 * Asking for an edit in words.
 *
 * Nothing here edits anything. A request goes off, comes back as a PLAN, and
 * sits there until somebody approves it - at which point the whole run goes
 * through `applyPlan` as a single undo step. Discarding one costs nothing
 * because nothing had happened yet.
 *
 * There is no key in this component, and deliberately so: a page cannot keep a
 * secret from itself. The key lives on the dev server, which is also where the
 * AGENT runs - see the bridge plugin in `vite.config.ts` and
 * `assistant/agent.ts`.
 *
 * Every request carries a fresh outline of the project, so it is answered
 * against what the timeline is NOW rather than a description that was true
 * several edits ago. The agent's own session carries the CONVERSATION, which is
 * what makes "now make it shorter" mean anything.
 */

type Entry = { role: 'you' | 'assistant'; text: string }

function Assistant({
  playheadMicrosRef,
  selectedSegmentId,
  scripts,
  pauses,
  signals,
  visuals,
  script,
  language,
}: {
  /**
   * WHERE the playhead is, as a ref rather than a value.
   *
   * It moves sixty times a second while playing, and a value prop would
   * re-render this whole column - conversation, script and all - for every one
   * of those frames. Nothing here DRAWS the playhead; it is read once, when a
   * request is sent. A ref is the honest shape for that.
   */
  playheadMicrosRef: { current: number }
  selectedSegmentId: string | null
  /**
   * What has been transcribed, by source id. Passed in rather than fetched here
   * because a transcript is derived from media and lives where the other
   * measured things live - see the peaks.
   */
  scripts?: Record<
    string,
    {
      language: string
      duration?: number
      segments: {
        start: number
        end: number
        text: string
        words?: { start: number; end: number; word: string }[]
      }[]
    }
  >
  /**
   * Where nobody is speaking, by source id, in SOURCE microseconds. Measured
   * from the peaks and sent beside the words: a boundary taken from a
   * transcript lands where a word begins, and a cut belongs in the gap before
   * it rather than on it.
   */
  pauses?: Record<string, { startMicros: number; endMicros: number }[]>
  /** What the words alone do not say, line by line. See `signals.ts`. */
  signals?: Record<
    string,
    { clarity?: number; loudness?: number; repeatOf?: number }[]
  >
  /** What each looked-at source shows, by source id, in SOURCE seconds. */
  visuals?: Record<
    string,
    {
      shots: { startSeconds: number; endSeconds: number; text: string }[]
      truncatedAfterSeconds?: number
    }
  >
  /**
   * What the SELECTED clip says, if it has been transcribed.
   *
   * Shown here rather than in the inspector, which is where a fact about the
   * selection would normally go. A script is what you read WHILE asking for a
   * cut - "take out the bit where I say that" needs both in view at once - and
   * the inspector is a narrow column of fields, not a place to read prose.
   */
  script?: {
    name: string
    segments: { start: number; end: number; text: string }[]
    /** What the transcriber ran on, when it is worth saying. */
    device?: string
  }
  /**
   * Which language the transcriber should expect, and how to change it.
   *
   * It sits in this column rather than the inspector because it governs the
   * SCRIPT, which is here - and because it is not a fact about the selection:
   * changing it says nothing about the clip, only about what to listen for
   * next. Absent when the selection has no sound, so there is nothing to set.
   */
  language?: {
    code: string
    onChange: (code: string) => void
    /** True while a transcription is running, when changing it would do nothing. */
    busy: boolean
  }
}) {
  const [request, setRequest] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [pending, setPending] = useState<BridgeOutcome | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * The agent's session, so a follow-up continues the conversation instead of
   * starting again. Kept across requests and deliberately not reset by applying
   * a plan: "now make it shorter" is about what was just discussed.
   */
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)

  // Kept out of state: nothing renders differently for it, and re-rendering
  // mid-request would only throw the field away under whoever is typing.
  const abort = useRef<AbortController | null>(null)

  /*
   * The live bridge, for an agent working outside the browser.
   *
   * Publishing is subscribed to the store rather than driven by a render, so
   * every edit is published whatever caused it - a drag, a shortcut, an applied
   * plan. Both halves are no-ops outside `npm run dev`.
   */
  useEffect(() => {
    publishProject(useTimelineStore.getState().project)

    const stopPublishing = useTimelineStore.subscribe((state) => {
      publishProject(state.project)
    })

    /*
     * Publishing again on the way back to the tab.
     *
     * The server holds ONE timeline, so another page - a second tab, or the
     * browser suite running against the same dev server - overwrites it. There
     * is no arbitrating that: whoever published last is what an agent reads.
     * Coming back to a tab is the moment its own timeline becomes the one being
     * worked on, so that is when it says so again, rather than waiting for the
     * next edit and leaving somebody reading a stale project until then.
     */
    const republish = () => {
      if (document.visibilityState === 'visible') {
        publishProject(useTimelineStore.getState().project)
      }
    }

    document.addEventListener('visibilitychange', republish)
    window.addEventListener('focus', republish)

    const stopListening = onLivePlan((plan) => {
      try {
        useTimelineStore.getState().applyPlan(plan.steps)
        setEntries((before) => [
          ...before,
          { role: 'assistant', text: plan.note ?? `Made ${plan.steps.length} changes.` },
        ])
      } catch (failure) {
        // Sent from outside against a timeline that has since moved on. Refused
        // whole by applyPlan, so there is nothing to undo - only to report.
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    })

    return () => {
      document.removeEventListener('visibilitychange', republish)
      window.removeEventListener('focus', republish)
      stopPublishing()
      stopListening()
    }
  }, [])

  async function send(event: FormEvent) {
    event.preventDefault()

    const asked = request.trim()
    if (asked.length === 0 || busy) return

    setBusy(true)
    setError(null)
    setPending(null)
    setEntries((before) => [...before, { role: 'you', text: asked }])
    setRequest('')

    abort.current = new AbortController()

    try {
      const outcome = await requestPlan({
        project: useTimelineStore.getState().project,
        request: asked,
        view: {
          playheadMicros: playheadMicrosRef.current,
          selectedSegmentId,
          scripts,
          pauses,
          signals,
          visuals,
        },
        sessionId,
        signal: abort.current.signal,
      })

      if (outcome.sessionId) setSessionId(outcome.sessionId)

      const spent =
        outcome.costUsd === undefined
          ? ''
          : ` (${outcome.costUsd < 0.01 ? '<$0.01' : `$${outcome.costUsd.toFixed(2)}`})`

      if (outcome.steps.length === 0) {
        // Nothing to approve, so there is nothing to hold back: whatever it
        // said is the whole answer.
        setEntries((before) => [
          ...before,
          {
            role: 'assistant',
            text: `${outcome.reply || 'Nothing to change.'}${spent}`,
          },
        ])
        if (outcome.warning) setError(outcome.warning)
        return
      }

      setPending({ ...outcome, reply: `${outcome.reply}${spent}` })
      if (outcome.warning) setError(outcome.warning)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
      abort.current = null
    }
  }

  function approve() {
    if (!pending) return

    // A plan is worked out against the project as it was when it was asked for.
    // Edit the timeline yourself in the meantime and a step can no longer apply
    // - so this refuses as a whole rather than leaving half a plan behind, and
    // says so instead of throwing where nobody would see it.
    try {
      useTimelineStore.getState().applyPlan(pending.steps)
    } catch (failure) {
      setError(
        `${failure instanceof Error ? failure.message : String(failure)} Nothing was changed - ask again to plan against the timeline as it is now.`,
      )
      setPending(null)
      return
    }

    setEntries((before) => [
      ...before,
      {
        role: 'assistant',
        text: pending.reply || `Made ${pending.steps.length} changes.`,
      },
    ])
    setPending(null)
  }

  function discard() {
    if (!pending) return

    setEntries((before) => [
      ...before,
      { role: 'assistant', text: 'Discarded that plan.' },
    ])
    setPending(null)
  }

  return (
    <aside className="assistant" data-testid="assistant">
      <h2>Assistant</h2>

      {language && (
        <label className="assistant-language" data-testid="script-language">
          <span>Spoken language</span>
          <select
            value={language.code}
            disabled={language.busy}
            onChange={(event) => language.onChange(event.target.value)}
          >
            {SPOKEN_LANGUAGES.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {script && (
        <section className="assistant-script" data-testid="script-panel">
          <h3>
            What is said in <span className="script-source">{script.name}</span>
          </h3>
          {script.segments.length === 0 ? (
            <p className="assistant-note" data-testid="script-empty">
              Nothing was said in this clip, or none of it was clear enough to
              make out.
            </p>
          ) : (
            <ol className="script-lines">
              {script.segments.map((line, index) => (
                <li key={index} data-testid="script-line">
                  <span className="script-at">{line.start.toFixed(2)}s</span>
                  <span>{line.text}</span>
                </li>
              ))}
            </ol>
          )}
          <p className="assistant-note" data-testid="script-device">
            Times are positions in the file, so they hold if you trim or move
            the clip.
            {script.device
              ? ` Transcribed on ${script.device.startsWith('cuda') ? 'the GPU' : 'the CPU, which is the slow one'}.`
              : ''}
          </p>
        </section>
      )}

      <div className="assistant-transcript" data-testid="assistant-transcript">
        {entries.length === 0 && (
          <p className="assistant-note">
            Ask for an edit: &ldquo;split the clip at 4 seconds and crossfade
            into it&rdquo;. The outline of your project - file names, timings
            and caption text - is sent to Anthropic. The video and audio never
            leave this machine.
          </p>
        )}
        {entries.map((entry, index) => (
          <p
            key={index}
            className={`assistant-line is-${entry.role}`}
            data-testid={`assistant-${entry.role}`}
          >
            {entry.text}
          </p>
        ))}
        {busy && (
          <p className="assistant-note" data-testid="assistant-busy">
            Working&hellip;
          </p>
        )}
      </div>

      {pending && (
        <div className="assistant-plan" data-testid="assistant-plan">
          <h3>{pending.steps.length} changes, not applied yet</h3>
          <ol>
            {pending.steps.map((step, index) => (
              <li key={index} data-testid="assistant-step">
                {step.label}
              </li>
            ))}
          </ol>
          <div className="assistant-verdict">
            <button
              type="button"
              data-testid="assistant-approve"
              onClick={approve}
            >
              Apply
            </button>
            <button
              type="button"
              data-testid="assistant-discard"
              onClick={discard}
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <p className="assistant-error" data-testid="assistant-error">
          {error}
        </p>
      )}

      <form className="assistant-ask" onSubmit={send}>
        <textarea
          value={request}
          rows={3}
          placeholder="What should change?"
          aria-label="What should change?"
          data-testid="assistant-prompt"
          onChange={(event) => setRequest(event.target.value)}
        />
        <button
          type="submit"
          data-testid="assistant-send"
          disabled={busy || request.trim().length === 0}
        >
          Ask
        </button>
      </form>
    </aside>
  )
}

/**
 * Re-rendered only when what it shows changes.
 *
 * The editor re-renders on every playback frame because the playhead lives in
 * its state. This column shows none of that, so it sits behind a memo and its
 * one moving input arrives as a ref.
 */
export default memo(Assistant)
