import { createAgent, run, user } from '@apeira/core'
let steps = 0
const ac = new AbortController()
// A runner whose model keeps asking for a tool, like a looping LLM.
const runner = async (ctx) => {
  steps++
  if (steps >= 500) ac.abort(new Error('test harness cap'))
  await new Promise(r => setTimeout(r, 1))
  return { output: [], toolCalls: [{ toolCallId: `c${steps}`, toolName: 'search', args: '{}' }] }
}
const agent = createAgent({ instructions: 'x', runner })
const t = performance.now()
const events = []
for await (const e of run(agent, user('go'), { signal: ac.signal })) events.push(e.type)
console.log(JSON.stringify({ stepsBeforeHarnessStop: steps, ms: Math.round(performance.now() - t), lastEvents: events.slice(-3) }))

// Steering: send while a turn is active.
let seen = []
const runner2 = async (ctx) => { seen.push(ctx.input.map(i => i.content).join('|')); await new Promise(r => setTimeout(r, 50)); return { output: [], toolCalls: ctx.stepNumber < 2 ? [{ toolCallId: 'x', toolName: 't', args: '{}' }] : [] } }
const a2 = createAgent({ instructions: 'x', runner: runner2 })
const id1 = a2.send(user('first'))
await new Promise(r => setTimeout(r, 20))
const id2 = a2.send(user('steer while running'))
await a2.wait()
console.log(JSON.stringify({ sameTurn: id1 === id2, runnerInputsPerStep: seen }))
