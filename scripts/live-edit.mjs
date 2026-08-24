/**
 * Edits the open timeline from a terminal.
 *
 * The editor publishes what it is showing to `live/project.json`; this sends
 * tool calls back the other way. They run through the same `dispatch` the
 * assistant uses, so this is a new way to ASK for an edit and not a new way to
 * make one - and the result lands in the browser as a single undo step.
 *
 * Read the timeline first:
 *   node scripts/live-edit.mjs --show
 *
 * Then edit it, in seconds, naming segments by the ids the outline gives:
 *   node scripts/live-edit.mjs '[{"tool":"split_segment","args":{"atSeconds":4}}]'
 *   node scripts/live-edit.mjs '[{"tool":"set_speed","args":{"segmentId":"...","rate":2}}]' "sped it up"
 *
 * `--tools` lists what can be asked for. The app must be open in a browser:
 * there is nothing to edit otherwise, and nothing to show it in.
 */

import { readFileSync } from 'node:fs'

const BASE = process.env.LIVE_EDIT_ORIGIN ?? 'http://localhost:5173'

function fail(message) {
  console.error(message)
  process.exit(1)
}

const [first, note] = process.argv.slice(2)

if (!first || first === '--help') {
  fail(
    'Usage:\n' +
      '  node scripts/live-edit.mjs --show\n' +
      '  node scripts/live-edit.mjs --tools\n' +
      '  node scripts/live-edit.mjs \'[{"tool":"...","args":{...}}]\' ["what to say"]',
  )
}

if (first === '--show') {
  try {
    process.stdout.write(readFileSync('live/project.json', 'utf8'))
  } catch {
    fail(
      'No timeline published yet. Start `npm run dev` and open the app in a browser.',
    )
  }
  process.exit(0)
}

if (first === '--tools') {
  // Straight from the schema the model is given, so this cannot drift from
  // what is actually accepted.
  const source = readFileSync('src/assistant/tools.ts', 'utf8')
  for (const [, name] of source.matchAll(/^    name: '([a-z_]+)',$/gm)) {
    console.log(name)
  }
  process.exit(0)
}

let calls
try {
  calls = JSON.parse(first)
} catch (error) {
  fail(`That is not JSON: ${error.message}`)
}

if (!Array.isArray(calls)) fail('Send an array of {tool, args}.')

const response = await fetch(`${BASE}/api/live/edit`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ calls, note }),
}).catch(() => fail(`Could not reach the dev server at ${BASE}.`))

const body = await response.json().catch(() => null)

if (!response.ok) {
  fail(body?.error ?? `The server refused it (${response.status}).`)
}

// The labels are the human reading of each step - the same ones the plan in the
// assistant column shows.
for (const step of body.steps) console.log(step.label)
