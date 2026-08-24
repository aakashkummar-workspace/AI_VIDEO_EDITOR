/**
 * Describing sampled frames, server-side.
 *
 * Runs where the credential is, exactly as `agent.ts` does and for the same
 * reason: a page cannot keep a secret from itself. It uses the Agent SDK rather
 * than a plain Messages call so it inherits the same fallback to whatever Claude
 * Code on this machine is signed in with - see the note in CLAUDE.md about this
 * being a local tool rather than a shippable feature.
 *
 * No tools, no MCP server, no session. This is one question with pictures
 * attached, and the answer is text.
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import { ASSISTANT_MODEL } from './client'
import { shotsFrom } from './shots'
import type { Visuals } from './vision'

const SYSTEM_PROMPT = `You are looking at frames taken from one video file, in
order. Each is labelled with the second of the file it came from.

You are describing footage for a video editor who cannot watch it. Say what is
actually visible - who or what is in frame, where it is, what is happening, and
anything that would make an editor want to cut: somebody walking out of shot, a
hand over the lens, a slate or clapper, a shot that is badly out of focus or
blown out, a title card, a static hold on nothing.

Be specific and be brief. Two sentences per shot at most. Do not speculate about
what is being said - you cannot hear it - and do not describe the same thing
twice in different words.

Answer with one line per shot, in this exact form and nothing else:

<start seconds>-<end seconds>: <what can be seen>

For example:

0-4.5: A woman sits at a desk facing the camera, a window behind her.
4.5-9: Close on her hands turning the pages of a notebook.`

/** What the endpoint hands over: frames, and where the picture already changed. */
export type WatchInput = {
  durationMicros: number
  boundariesMicros: number[]
  frames: { atMicros: number; jpegBase64: string }[]
}

/**
 * Turns frames into a description per shot.
 *
 * The shot BOUNDARIES are computed before this is called - by `shots.ts`, from
 * numbers, without a model - and handed in. The model is asked only what it is
 * uniquely able to answer. That split is the same one `silence.ts` makes
 * against the transcriber, and it is what keeps the answer reproducible where
 * it can be.
 */
export async function watchFrames(
  input: WatchInput,
  everySeconds: number,
): Promise<Visuals> {
  const shots = shotsFrom(input.boundariesMicros, input.durationMicros)

  const content: Record<string, unknown>[] = [
    {
      type: 'text',
      text:
        `This file is ${(input.durationMicros / 1e6).toFixed(1)} seconds long. ` +
        `The picture changes at: ${
          shots.length === 1
            ? 'nowhere - it is one continuous shot'
            : shots
                .slice(1)
                .map((shot) => `${(shot.startMicros / 1e6).toFixed(2)}s`)
                .join(', ')
        }. Describe each of those ${shots.length} shot(s).`,
    },
  ]

  for (const frame of input.frames) {
    content.push({
      type: 'text',
      text: `at ${(frame.atMicros / 1e6).toFixed(2)}s:`,
    })
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: frame.jpegBase64,
      },
    })
  }

  // A streaming-input prompt, which is the only shape that carries anything but
  // text: a plain string prompt has nowhere to put an image.
  async function* ask() {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content },
      parent_tool_use_id: null,
      session_id: '',
    }
  }

  const run = query({
    prompt: ask() as never,
    options: {
      model: ASSISTANT_MODEL,
      maxTurns: 1,
      systemPrompt: SYSTEM_PROMPT,
      // Nothing but the question: no tools, and nothing read off this disk.
      tools: [],
      settingSources: [],
    },
  })

  let reply = ''
  for await (const message of run as AsyncIterable<Record<string, unknown>>) {
    if (message['type'] === 'assistant') {
      const inner = message['message'] as { content?: unknown[] } | undefined
      for (const block of inner?.content ?? []) {
        const part = block as { type?: string; text?: string }
        if (part.type === 'text' && part.text) reply += part.text
      }
    }
    if (message['type'] === 'result' && message['subtype'] !== 'success') {
      throw new Error(
        String(message['result'] ?? 'The model could not look at those frames.'),
      )
    }
  }

  return {
    everySeconds,
    shots: parseShots(reply, input.durationMicros / 1e6),
  }
}

/**
 * Reads the model's lines back into shots.
 *
 * Tolerant on purpose, and clamped: a description that claims to run past the
 * end of the file would put an agent's cut outside the footage, and the one
 * thing worse than no description is one with wrong times in it.
 */
export function parseShots(
  reply: string,
  durationSeconds: number,
): { startSeconds: number; endSeconds: number; text: string }[] {
  const shots: { startSeconds: number; endSeconds: number; text: string }[] = []

  for (const line of reply.split('\n')) {
    const match = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*:\s*(.+)$/.exec(line)
    if (!match) continue

    const startSeconds = Math.max(0, Math.min(durationSeconds, Number(match[1])))
    const endSeconds = Math.max(0, Math.min(durationSeconds, Number(match[2])))
    const text = match[3]!.trim()
    if (endSeconds <= startSeconds || text.length === 0) continue

    shots.push({ startSeconds, endSeconds, text })
  }

  return shots
}
