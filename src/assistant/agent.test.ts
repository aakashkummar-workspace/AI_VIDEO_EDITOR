import { describe, expect, it } from 'vitest'
import { QUESTION_NAMES, toolSchemas } from './agent'
import { TOOL_SPECS } from './tools'

/**
 * What the agent is offered.
 *
 * The run itself needs a key, a subprocess and a network, and is covered in the
 * browser suite with the endpoint stubbed. What is worth testing here is the
 * part that can silently go wrong without one: the schemas handed to the agent
 * are DERIVED from the same specs the rest of the application dispatches on, so
 * it can never be offered an operation that does not exist, or offered one with
 * the wrong arguments.
 */

describe('the schemas the agent is given', () => {
  it('covers every tool and nothing else', () => {
    expect(Object.keys(toolSchemas()).sort()).toEqual(
      TOOL_SPECS.map((spec) => spec.name).sort(),
    )
  })

  it('names every field the spec names', () => {
    for (const spec of TOOL_SPECS) {
      const shape = toolSchemas()[spec.name]!
      expect(Object.keys(shape).sort(), spec.name).toEqual(
        Object.keys(spec.fields).sort(),
      )
    }
  })

  it('makes a required field required and an optional one optional', () => {
    for (const spec of TOOL_SPECS) {
      const shape = toolSchemas()[spec.name]!

      for (const name of Object.keys(spec.fields)) {
        const wanted = spec.required.includes(name)
        expect(
          shape[name]!.safeParse(undefined).success,
          `${spec.name}.${name} required=${wanted}`,
        ).toBe(!wanted)
      }
    }
  })

  it('accepts a value the timeline allows and refuses one it does not', () => {
    const shape = toolSchemas()['add_transition']!

    expect(shape['kind']!.safeParse('crossfade').success).toBe(true)
    expect(shape['kind']!.safeParse('star-wipe').success).toBe(false)
    expect(shape['durationSeconds']!.safeParse(0.5).success).toBe(true)
    expect(shape['durationSeconds']!.safeParse('half').success).toBe(false)
  })

  it('asks for seconds, never microseconds', () => {
    // The agent speaks seconds and the tool boundary converts. A field named in
    // microseconds would mean that conversion had been bypassed.
    for (const spec of TOOL_SPECS) {
      for (const name of Object.keys(spec.fields)) {
        expect(name.toLowerCase(), spec.name).not.toContain('micros')
      }
    }
  })

  it('never asks the agent for an id it would have to invent', () => {
    // Ids are minted by the dispatcher; an agent cannot see the ones in use.
    for (const spec of TOOL_SPECS) {
      const fields = Object.keys(toolSchemas()[spec.name]!)
      expect(fields, spec.name).not.toContain('newSegmentId')
      expect(fields, spec.name).not.toContain('id')
    }
  })

  it('describes every field, since the description is what it reads', () => {
    for (const spec of TOOL_SPECS) {
      for (const [name, field] of Object.entries(spec.fields)) {
        expect(field.description.length, `${spec.name}.${name}`).toBeGreaterThan(
          0,
        )
      }
    }
  })
})

describe('the questions the agent can ask', () => {
  it('offers a way to read the edit back, and to check a cut first', () => {
    // The agent used to plan blind: it knew what it had asked for and what the
    // timeline was before, and could never look at what it had made.
    expect(QUESTION_NAMES).toContain('read_back')
    expect(QUESTION_NAMES).toContain('check_cuts')
  })

  it('keeps the questions out of the edit surface', () => {
    // Every tool in TOOL_SPECS names a mutator. These name none, which is
    // exactly why they are not in there.
    const edits = TOOL_SPECS.map((spec) => spec.name)
    for (const question of QUESTION_NAMES) {
      expect(edits).not.toContain(question as string)
    }
  })
})
