import { writeFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { Scheduler, WorkingMemory } from './scheduler'

const OUT = '/tmp/claude-0/-home-user-airi/2cfc5d2d-9ecc-5213-9850-5921d2e08d4c/scratchpad/v/proto-results.json'
const results: Record<string, unknown> = {}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('scheduler prototype', () => {
  it('s1 preemption on one slot, and what the runtime does to history', async () => {
    const s = new Scheduler({ slots: 1, wmBudget: 400 })
    const t0 = performance.now()
    const game = s.submit({ binding: 'minecraft:bot', personaId: 'airi', text: 'plan the castle', priority: 2, source: 'module', script: { durMs: 600, text: 'castle plan' } })
    await sleep(50)
    const tOwner = performance.now()
    const owner = s.submit({ binding: 'owner:private', personaId: 'airi', text: 'hi!', priority: 0, source: 'user', script: { durMs: 80, text: 'hello' } })
    const ownerRun = await owner
    const ownerDone = performance.now() - tOwner
    const gameRun = await game
    const gameCtx = s.store.findByBinding('airi', 'minecraft:bot')!
    const userTurns = gameCtx.messages.filter(m => m.role === 'user').length
    results.s1 = {
      preemptions: s.pool.preemptions,
      ownerLatencyMs: Math.round(ownerDone),
      ownerState: ownerRun.state,
      gameFinalState: gameRun.state,
      gameTotalMs: Math.round(performance.now() - t0),
      gameUserTurnsInHistory: userTurns,
      gameAssistantTurns: gameCtx.messages.filter(m => m.role === 'assistant').length,
      log: s.log,
    }
    expect(s.pool.preemptions).toBe(1)
  })

  it('s2 coalescing', async () => {
    const s = new Scheduler({ slots: 1, wmBudget: 400 })
    const busy = s.submit({ binding: 'minecraft:bot', personaId: 'airi', text: 'long plan', priority: 2, source: 'module', preemptible: false, script: { durMs: 200 } })
    await sleep(20)
    const discord = await Promise.all(Array.from({ length: 5 }, (_, i) => s.submit({ binding: 'discord:g1', personaId: 'airi', text: `msg ${i}`, priority: 1, source: 'stranger', script: { durMs: 40 } })))
    await busy
    const ctx = s.store.findByBinding('airi', 'discord:g1')!
    results.s2 = { submitted: 5, merged: s.merged, distinctRuns: new Set(discord.map(r => r.runId)).size, userTurn: ctx.messages.find(m => m.role === 'user')?.content }
  })

  it('s3 resume vs create by binding, dormant digest', async () => {
    const s = new Scheduler({ slots: 2, wmBudget: 400 })
    const a = await s.submit({ binding: 'discord:g1', personaId: 'airi', text: 'hello', priority: 1, source: 'stranger', script: { durMs: 10 } })
    const b = await s.submit({ binding: 'discord:g1', personaId: 'airi', text: 'again', priority: 1, source: 'stranger', script: { durMs: 10 } })
    const c = await s.submit({ binding: 'discord:g1', personaId: 'mika', text: 'hi mika', priority: 1, source: 'stranger', script: { durMs: 10 } })
    s.store.demoteIdle(Date.now() + 10_000, 5_000, ctx => `last ${ctx.messages.length} messages about greetings`)
    const dormant = s.store.findByBinding('airi', 'discord:g1')!.status
    const d = await s.submit({ binding: 'discord:g1', personaId: 'airi', text: 'back', priority: 1, source: 'stranger', script: { durMs: 10 } })
    results.s3 = { sameContextForSameBinding: a.contextId === b.contextId && b.contextId === d.contextId, otherPersonaGetsOwnContext: c.contextId !== a.contextId, statusBeforeResume: dormant, historyLengthAfterResume: s.store.contexts.get(d.contextId)!.messages.length, digest: s.store.contexts.get(d.contextId)!.digest }
  })

  it('s4 spawn by proposal, result routing, cascade cancel', async () => {
    const s = new Scheduler({ slots: 3, wmBudget: 400 })
    const parent = await s.submit({ binding: 'stream:main', personaId: 'airi', text: 'comment on the game', priority: 1, source: 'module', script: { durMs: 30, proposeChild: { binding: 'task:scout', text: 'scout the map' } } })
    const [child] = await Promise.all(s.childPromises)
    const parentCtx = parent.contextId
    const childCtx = s.store.contexts.get(child.contextId)!
    const visibleToParent = s.wm.project(parentCtx).map(m => m.contextId)
    const visibleToOwner = s.wm.project('owner-ctx').map(m => m.contextId)
    // Cascade cancel: a long parent with a long child.
    const s2 = new Scheduler({ slots: 3, wmBudget: 400 })
    const p2 = s2.submit({ binding: 'stream:main', personaId: 'airi', text: 'x', priority: 1, source: 'module', script: { durMs: 400, proposeChild: undefined } })
    await sleep(30)
    const parentRun = [...s2.runs.values()][0]
    s2.propose(parentRun, { binding: 'task:scout', text: 'long scout' })
    ;(s2 as unknown as { scripts: Map<string, { durMs: number }> }).scripts.set([...s2.runs.keys()].at(-1)!, { durMs: 1000 })
    await sleep(30)
    s2.cancel(parentRun.runId, 'owner said stop')
    const [child2] = await Promise.all(s2.childPromises)
    await p2
    results.s4 = { childParentRun: child.parentRunId === parent.runId, childSeededFromDigest: childCtx.messages[0]?.content, childParentContext: childCtx.parentContextId === parentCtx, resultVisibleToParent: visibleToParent, resultVisibleToOwner: visibleToOwner, cascade: { parent: parentRun.state, child: child2.state } }
  })

  it('s5 supervisor catches stall and loop', async () => {
    const s = new Scheduler({ slots: 2, wmBudget: 400, stallMs: 150 })
    const timer = setInterval(() => s.supervise(), 20)
    const t = performance.now()
    const [stall, loop] = await Promise.all([
      s.submit({ binding: 'task:a', personaId: 'airi', text: 'stall', priority: 1, source: 'module', script: { durMs: 5000, stallAfterMs: 50 } }),
      s.submit({ binding: 'task:b', personaId: 'airi', text: 'loop', priority: 1, source: 'module', script: { durMs: 5000, loopTool: true } }),
    ])
    clearInterval(timer)
    results.s5 = { stall: stall.state, loop: loop.state, detectedWithinMs: Math.round(performance.now() - t), log: s.log }
  })

  it('s6 working memory under the one-hour load of bench b2', () => {
    let now = 0
    const wm = new WorkingMemory(400, 80, () => now)
    let maxOwner = 0
    let maxDiscord = 0
    for (let sec = 0; sec <= 3600; sec++) {
      now = sec * 1000
      if (sec % 5 === 0)
        wm.write({ slot: 'minecraft:status', text: 'Bot online. HP 18/20. Position x 12 y 64 z -88. Owner online.', writer: 'minecraft', salience: 0.6, expiresAt: now + 15_000, destinations: 'all' })
      if (sec % 30 === 0)
        wm.write({ slot: `minecraft:event:${sec}`, text: `Collected 12 oak logs near x:${sec % 100}.`, writer: 'minecraft', salience: 0.3, expiresAt: now + 120_000, destinations: 'all' })
      if (sec % 4 === 0)
        wm.write({ slot: `discord:${sec % 8 ? 'g1' : 'g2'}`, text: `Discord guild message arrived in channel ${sec % 7}.`, writer: 'discord', salience: 0.2, expiresAt: now + 30_000, destinations: ['ctx-discord-g1', 'ctx-discord-g2'] })
      maxOwner = Math.max(maxOwner, wm.tokensFor('ctx-owner'))
      maxDiscord = Math.max(maxDiscord, wm.tokensFor('ctx-discord-g1'))
    }
    results.s6 = { budget: 400, maxTokensOwnerReader: maxOwner, maxTokensDiscordReader: maxDiscord, rejected: wm.rejected, evicted: wm.evicted, note: 'Bench b2 without these rules reached 25,822 tokens after one hour.' }
  })

  it('s7 JEV admission end to end (real JEV via OpenCode Zen)', async () => {
    const { TRIAGE, WORLD } = await import('/tmp/claude-0/-home-user-airi/2cfc5d2d-9ecc-5213-9850-5921d2e08d4c/scratchpad/v/dataset.mjs')
    const { jev } = await import('/tmp/claude-0/-home-user-airi/2cfc5d2d-9ecc-5213-9850-5921d2e08d4c/scratchpad/v/jev.mjs')
    const s = new Scheduler({ slots: 2, wmBudget: 400 })
    const bindingOf: Record<string, string> = { ownerChat: 'owner:private', stream: 'stream:main', game: 'minecraft:bot', discord: 'discord:g1' }
    const q = {
      act: { type: 'noul', instructions: 'This event needs a reaction from the character right now.' },
      route: { type: 'choice', instructions: 'If the character reacts, where should the reaction go?', criteria: { ownerChat: 'Private chat with the owner (personal matters, reminders, home, device status)', stream: 'Live stream audience (things that happen on stream)', game: 'Guidance to the Minecraft bot', discord: 'The Discord channel where it happened' } },
      urgency: { type: 'score', instructions: 'How urgent is this event for the character overall?', criteria: ['ignorable', 'low', 'normal', 'high', 'critical'] },
    }
    const decisions: unknown[] = []
    const jevMs: number[] = []
    const runs: Promise<unknown>[] = []
    for (const e of TRIAGE) {
      const r = await jev({ world: WORLD.en, event: e.en }, q)
      jevMs.push(r.ms)
      const act = r.answers.act.noul >= 0.5
      const route = act ? r.answers.route.choice : 'none'
      decisions.push({ id: e.id, act, route, expected: e.route, urgency: r.answers.urgency.score })
      if (act)
        runs.push(s.submit({ binding: bindingOf[route], personaId: 'airi', text: e.en, priority: 4 - Math.round(r.answers.urgency.score), source: 'module', script: { durMs: 30 } }))
    }
    await Promise.all(runs)
    const correct = (decisions as Array<{ route: string, expected: string }>).filter(d => d.route === d.expected).length
    const sorted = [...jevMs].sort((a, b) => a - b)
    results.s7 = { events: TRIAGE.length, runsStarted: runs.length, runsAvoided: TRIAGE.length - runs.length, routeCorrect: `${correct}/${TRIAGE.length}`, contextsCreated: s.store.contexts.size, jevMsP50: Math.round(sorted[Math.floor(sorted.length / 2)]), jevMsMax: Math.round(sorted.at(-1)!), decisions }
    writeFileSync(OUT, JSON.stringify(results, null, 1))
  }, 120_000)
})
