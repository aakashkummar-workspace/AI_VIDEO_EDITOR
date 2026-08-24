/**
 * The editing agent.
 *
 * This is the Claude Code Agent SDK driving the timeline: it owns the loop, the
 * context and the tool calls, and the eighteen operations are handed to it as an
 * in-process MCP server. What that buys over a single planning request is a real
 * agent - sessions, so "now make it shorter" means something; managed context,
 * so a long job does not fall off the end of a window; and turn limits and costs
 * reported rather than guessed.
 *
 * Two rules hold regardless of which loop is in charge:
 *
 * - THE TOOLS ARE STILL `tools.ts`. Every handler below calls `dispatch`, the
 *   same function the plan/approve flow calls, which calls the same mutators the
 *   buttons call. The zod schemas are DERIVED from `TOOL_SPECS` rather than
 *   written out again, so the agent cannot be offered an operation the rest of
 *   the application does not have.
 * - IT STILL ONLY PLANS. Handlers apply to a scratch copy of the project and
 *   record what they did; the store sees nothing until somebody approves it.
 *
 * The built-in tools are switched OFF. This agent edits a timeline; a video
 * editor has no business being handed Read, Edit or Bash, and `settingSources`
 * is emptied so it does not pick up this repository's own CLAUDE.md and start
 * behaving like a coding assistant.
 */

import {
  createSdkMcpServer,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk'
import { z, type ZodTypeAny } from 'zod'
import { ASSISTANT_MODEL } from './client'
import { describeProject, type ProjectView } from './describe'
import { TOOL_SPECS, dispatch, type PlanStep } from './tools'
import { checkBoundaries, spokenOnTimeline, wordsOf } from './inspect'
import type { Project } from '../timeline/types'

/** What the MCP server is called, and so what its tools are prefixed with. */
const SERVER_NAME = 'timeline'

/**
 * How many turns before it is stopped.
 *
 * A run that has not settled by now is looping rather than working, and every
 * turn costs the user money.
 */
/**
 * Enough turns to check, cut, read the result back and fix it.
 *
 * Twelve was set when the agent could only act. It now has to look before and
 * after every cut, and a plan that ran out of turns halfway through verifying
 * itself would be worse than one that never tried.
 */
const MAX_TURNS = 24

const SYSTEM_PROMPT = `You are the editing agent inside a video editor. You turn
a request in plain language into edits on the timeline, using the tools you have
been given and nothing else.

How the timeline works:

- A project is a stack of TRACKS, listed bottom of the stack first. Higher rows
  are drawn over lower ones.
- A track holds SEGMENTS. A segment plays part of a source file, or draws text.
- Video and audio rows are PACKED: segments may not overlap, and the only
  exception is a transition. Text rows allow overlap freely.
- A video or audio segment's length comes from how much of its source it plays
  and how fast; only text stores its own duration.
- Times you send are in SECONDS, and so are the times you are shown.
- Keyframe offsets are measured from the SEGMENT'S OWN START, not from the
  timeline, so an animation survives the segment being moved.

How to work:

- Nothing you do is applied yet. Your edits are collected into a plan that the
  person will approve or discard, so prefer doing the whole job over asking
  whether to start.
- Read the outline before acting, and refer to segments by the ids it gives you.
- Several operations move OTHER segments: a transition pulls everything after it
  earlier, a duplicate pushes everything after it later, a speed change moves a
  segment's own tail. Each tool result says where things actually ended up -
  trust that over what you asked for, especially after a trim, which clamps
  silently rather than refusing.
- If a tool fails, read the message. It says what the model of the timeline does
  not allow, and usually implies the fix.
- You cannot hear the audio and you cannot see the pictures. If the outline has
  a "scripts" section, that is a transcript of what is said, in SOURCE seconds.
  If there is no script for a file, you do not know what is said in it. Say so;
  never guess, and never invent a transcript.
- A line may carry "words": a list of [start, end, word] in SOURCE seconds. Use
  them. They are what lets you cut one sentence out of a line rather than the
  whole line, and a line is usually several sentences long. If a script says
  "wordsOmitted": true the file was too long to send them, and a whole line is
  then the finest boundary you have - say so rather than pretending otherwise.
- A script may also carry "pauses": [start, end] pairs, in SOURCE seconds, where
  nobody is speaking. PUT YOUR CUT BOUNDARIES INSIDE THESE. A word's start time
  is the moment the sound begins, so cutting exactly on it clips the consonant
  and swallows the breath before it. Choosing the pause that sits between two
  words instead is the whole difference between a cut that sounds deliberate and
  one that sounds broken. When no pause is available near a boundary, leave a
  little room rather than landing exactly on the word.
- If the outline has a "visuals" section, that is what the footage LOOKS like:
  one entry per shot, in SOURCE seconds, from frames somebody had looked at. Use
  it for anything about the picture - a shot held on nothing, somebody walking
  out of frame, a slate at the head of a take. It is sampled every couple of
  seconds, so a boundary in it is accurate to about that and not to the frame;
  when a script is available too, prefer the words for exact timing and the
  shots for deciding WHAT to cut. If there is no visuals section you have not
  seen the footage: say so rather than guessing at it.
- A LINE MAY CARRY THREE FLAGS, and together they are most of what separates a
  rehearsal from a take. "unclear" means the transcriber was markedly unsure of
  it - mumbling, an aside, a line read quietly to oneself. "quiet" means it is
  markedly softer than the rest of the take. "repeatOf" gives the index of an
  earlier line this one closely repeats, and the LATER of such a pair is almost
  always the delivery worth keeping.
  A line that is unclear AND quiet AND repeated is a rehearsal with about as
  much certainty as this can be had. One flag on its own is a hint, not a
  verdict: somebody can be quiet because they are making a serious point.
  None of these is a guess - they are measured from the audio and the words -
  so weigh them above your own impression of the text.
- WORK IN THREE PASSES WHEN YOU ARE CUTTING TO A SCRIPT, and do not skip the
  last one. First decide from the transcript WHICH stretches go. Then run those
  boundaries through check_cuts and move any that land inside a word to the
  pause it suggests. Only then call remove_spoken_ranges. Finally call
  read_back and read what the timeline now says: if a sentence has been left in
  halves, or something you meant to keep has gone, fix it before you answer.
  Guessing at boundaries and never looking at the result is how a cut ends up
  technically correct and unlistenable.
- read_back and check_cuts change nothing. They cost a turn and they are worth
  it: an edit you have not read is an edit you have not checked.
- Cut ONLY what was asked for. A request to remove one thing is not licence to
  tidy up others: if you notice something else worth cutting, say so in your
  reply and leave it. Every extra second removed is a second somebody has to
  notice is missing and put back by hand.
- TO CUT A CLIP TO WHAT WAS SAID, use remove_spoken_ranges. It takes the same
  SOURCE seconds the transcript is written in, so a line is cut by quoting its
  own start and end back - no arithmetic, and no conversion to timeline time.
  Give it every range you want gone in ONE call: it closes the gaps and pulls
  what follows earlier. Do NOT reach for a run of splits and deletes to do this.
  Each split changes the ids and the times every later one would need, and a
  plan built that way is wrong from its second step onwards.
- Source time is not timeline time, and only remove_spoken_ranges spares
  you the difference. Every other tool takes TIMELINE seconds: a clip
  playing source 10s-20s at timeline 5s puts source 12s at timeline 7s.
- When you are done, say briefly what you did, in plain language, without ids.`

/**
 * The tools that ask rather than change.
 *
 * Named here so the difference is checkable without running an agent: every
 * name in `TOOL_SPECS` maps to a mutator, and every name in this list maps to
 * none. Nothing may appear in both.
 */
export const QUESTION_NAMES = ['read_back', 'check_cuts'] as const

/** One field of a tool's schema, as zod rather than as JSON Schema. */
function zodFor(field: {
  type: 'string' | 'number' | 'boolean' | 'ranges'
  description: string
  enum?: readonly string[]
}): ZodTypeAny {
  // The one compound kind: a list of source-time ranges. See tools.ts.
  if (field.type === 'ranges') {
    return z
      .array(z.object({ fromSeconds: z.number(), toSeconds: z.number() }))
      .describe(field.description)
  }

  if (field.enum && field.enum.length > 0) {
    // z.enum needs a non-empty tuple; the specs guarantee one.
    return z
      .enum(field.enum as unknown as [string, ...string[]])
      .describe(field.description)
  }

  if (field.type === 'number') return z.number().describe(field.description)
  if (field.type === 'boolean') return z.boolean().describe(field.description)
  return z.string().describe(field.description)
}

/**
 * The zod shape for every tool, keyed by name.
 *
 * Exported so the derivation can be checked without a key, a subprocess or a
 * network: these schemas are the contract between the agent and the rest of the
 * application, and getting one wrong is the kind of mistake that only shows up
 * as the agent quietly failing to call something.
 */
export function toolSchemas(): Record<string, Record<string, ZodTypeAny>> {
  return Object.fromEntries(
    TOOL_SPECS.map((spec) => [
      spec.name,
      Object.fromEntries(
        Object.entries(spec.fields).map(([name, field]) => [
          name,
          spec.required.includes(name)
            ? zodFor(field)
            : zodFor(field).optional(),
        ]),
      ),
    ]),
  )
}

export type AgentOutcome = {
  /** The operations the agent worked out, in the order it applied them. */
  steps: PlanStep[]
  /** The project as it would be if every step were applied. */
  project: Project
  /** What the agent said about the job, for the transcript. */
  reply: string
  /** What the run actually cost, as reported by the SDK. */
  costUsd?: number
  /** Set when the run stopped for a reason worth telling the user about. */
  warning?: string
}

export async function runAgent(options: {
  project: Project
  request: string
  view?: ProjectView
  /** Continues an earlier run, so a follow-up has something to refer to. */
  resumeSessionId?: string
}): Promise<AgentOutcome & { sessionId?: string }> {
  // The scratch copy. Every tool call replaces it; the real store is untouched
  // until somebody approves the steps that produced it.
  let scratch = options.project
  const steps: PlanStep[] = []

  const schemas = toolSchemas()

  const tools = TOOL_SPECS.map((spec) =>
    tool(
      spec.name,
      spec.description,
      schemas[spec.name]!,
      async (args: Record<string, unknown>) => {
        try {
          const outcome = dispatch(scratch, spec.name, args)
          scratch = outcome.project
          steps.push(outcome.step)
          return { content: [{ type: 'text' as const, text: outcome.step.summary }] }
        } catch (error) {
          // Not a failure of the run: this is how the agent learns a rule it
          // could not have known. The message is already written for a reader.
          return {
            content: [
              {
                type: 'text' as const,
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          }
        }
      },
      // Every one of these changes the plan, and none of them reaches outside
      // this process.
      { annotations: { readOnlyHint: false, openWorldHint: false } },
    ),
  )

  /**
   * The questions, as opposed to the edits.
   *
   * Every tool above names a mutator and changes the plan. These two change
   * nothing at all: they let the agent LOOK at what it has made, which it could
   * not do before. It knew what it had asked for and what the timeline was
   * beforehand; whether the result still said anything sensible was beyond it,
   * and that is the difference between cutting to a script and cutting at
   * numbers taken from one.
   *
   * They read the SCRATCH project, so the answer is the edit as it currently
   * stands rather than as it started.
   */
  const questions = [
    tool(
      QUESTION_NAMES[0],
      'Read the timeline back as speech, in the order it would be heard, ' +
        'AFTER the edits made so far. Use it to check a cut left whole ' +
        'sentences behind rather than halves of two. Says nothing about a ' +
        'source nobody has transcribed.',
      {},
      async () => {
        const lines = spokenOnTimeline(scratch, options.view?.scripts ?? {})
        return {
          content: [
            {
              type: 'text' as const,
              text:
                lines.length === 0
                  ? 'Nothing on the timeline has a transcript.'
                  : JSON.stringify(lines),
            },
          ],
        }
      },
      { annotations: { readOnlyHint: true, openWorldHint: false } },
    ),
    tool(
      QUESTION_NAMES[1],
      'Ask whether cut points land somewhere they can be heard. Takes SOURCE ' +
        'seconds for one source and says, for each, which word it would cut ' +
        'through and where the nearest pause is. Check before cutting: a ' +
        'boundary from a transcript lands where a word BEGINS, which clips ' +
        'the consonant and swallows the breath before it.',
      {
        sourceId: z.string().describe('Which source the seconds belong to.'),
        seconds: z
          .array(z.number())
          .describe('The proposed boundaries, in source seconds.'),
      },
      async (args: Record<string, unknown>) => {
        const sourceId = String(args['sourceId'])
        const script = options.view?.scripts?.[sourceId]
        const pauses = (options.view?.pauses?.[sourceId] ?? []).map((span) => ({
          fromSeconds: span.startMicros / 1e6,
          toSeconds: span.endMicros / 1e6,
        }))

        if (!script) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Nothing has been transcribed for ${sourceId}, so there is nothing to check against.`,
              },
            ],
          }
        }

        const verdicts = checkBoundaries(
          (args['seconds'] as number[]) ?? [],
          wordsOf(script),
          pauses,
        )
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(verdicts) }],
        }
      },
      { annotations: { readOnlyHint: true, openWorldHint: false } },
    ),
  ]

  const server = createSdkMcpServer({
    name: SERVER_NAME,
    version: '1.0.0',
    instructions: 'Edit the timeline with these operations.',
    tools: [...tools, ...questions],
    // Kept in the first prompt: there are only eighteen, and deferring them
    // would spend a turn discovering what this agent is for.
    alwaysLoad: true,
  })

  const outline = describeProject(options.project, options.view)
  const prompt =
    `Here is the project right now:\n\n${JSON.stringify(outline, null, 1)}` +
    `\n\nWhat I want: ${options.request}`

  const replies: string[] = []
  let costUsd: number | undefined
  let sessionId: string | undefined
  let warning: string | undefined

  const run = query({
    prompt,
    options: {
      model: ASSISTANT_MODEL,
      maxTurns: MAX_TURNS,
      systemPrompt: SYSTEM_PROMPT,
      mcpServers: { [SERVER_NAME]: server },
      // The only tools it may call, and the only ones it is given: a video
      // editor's agent has no business with the filesystem or a shell.
      allowedTools: [`mcp__${SERVER_NAME}__*`],
      tools: [],
      // Nothing from disk: not this repository's CLAUDE.md, not its skills,
      // not a user's global Claude Code settings.
      settingSources: [],
      ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {}),
    },
  })

  for await (const message of run as AsyncIterable<Record<string, unknown>>) {
    if (message['type'] === 'system' && message['subtype'] === 'init') {
      sessionId = message['session_id'] as string | undefined

      const servers = message['mcp_servers'] as
        | { name: string; status: string }[]
        | undefined
      const broken = servers?.filter(
        (entry) => entry.status === 'failed' || entry.status === 'needs-auth',
      )
      if (broken?.length) {
        warning = `The editing tools did not load (${broken
          .map((entry) => `${entry.name}: ${entry.status}`)
          .join(', ')}).`
      }
      continue
    }

    if (message['type'] === 'result') {
      costUsd = message['total_cost_usd'] as number | undefined
      const text = message['result']
      if (typeof text === 'string' && text.trim().length > 0) {
        replies.push(text.trim())
      }
      if (message['subtype'] !== 'success') {
        warning ??= `The agent stopped early (${String(message['subtype'])}).`
      }
    }
  }

  return {
    steps,
    project: scratch,
    reply: replies.join('\n').trim(),
    costUsd,
    sessionId,
    warning,
  }
}
