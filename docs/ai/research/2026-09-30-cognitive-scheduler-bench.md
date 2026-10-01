# Cognitive scheduler bench harness

Harness for §17 of [the white paper](./2026-09-30-cognitive-scheduler.md). It runs the real core-agent runtime with a fake LLM port.

Setup:

1. Save the code below as `packages/core-agent/src/runtime/zz-bench.test.ts`.
2. Install `js-tiktoken` outside the repository. Set `TIKTOKEN` to its `dist/index.js` path.
3. Set `BENCH_OUT` to the output JSON path.
4. From `packages/core-agent`, run `pnpm exec vitest run --config vitest.config.ts src/runtime/zz-bench.test.ts`.
5. Delete the test file after the run.

```ts
// Place at packages/core-agent/src/runtime/zz-bench.test.ts and run from packages/core-agent:
//   pnpm exec vitest run --config vitest.config.ts src/runtime/zz-bench.test.ts
// Needs: pnpm install --filter "@proj-airi/core-agent...", then build stream-kit, server-shared, provider-inference.
// Token counts use js-tiktoken (o200k_base), installed outside the repository. Set TIKTOKEN to its dist/index.js path.
import type { GenerationProvider } from '@proj-airi/provider-inference'

import type { Conversation } from '../messages/types'
import type { ChatHistoryItem, ContextMessage } from '../types/chat'

import process from 'node:process'

import { writeFileSync } from 'node:fs'

import { describe, it } from 'vitest'

import { createSparkNotifyAgent } from '../agents/spark-notify/agent'
import { renderConversationPreview } from '../messages/preview'
import { createChatOrchestratorRuntime } from './chat-orchestrator-runtime'
import { createContextRegistry } from './context-registry'

const { getEncoding } = await import(process.env.TIKTOKEN!)
const OUT = process.env.BENCH_OUT ?? 'bench-results.json'
const results: Record<string, unknown> = {}
const enc = getEncoding('o200k_base')
const tokens = (s: string): number => enc.encode(s).length

const provider: GenerationProvider = {
  generation: model => ({ protocol: 'chat-completions', config: { model, baseURL: 'https://example.com/' } }),
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = seed + 0x6D2B79F5 | 0
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
}

// Bench 1: head-of-line blocking. 1 simulated second = SCALE ms of real time.
const SCALE = 20
interface Job { at: number, session: string, kind: 'game' | 'discord' | 'owner', dur: number }

function makeWorkload(seed: number, horizon = 180): Job[] {
  const rnd = mulberry32(seed)
  const jobs: Job[] = []
  for (let t = 0; t < horizon; t += 15 + rnd() * 5)
    jobs.push({ at: t, session: 'game', kind: 'game', dur: 8 + rnd() * 8 })
  for (let t = 1; t < horizon; t += 2 + rnd() * 4)
    jobs.push({ at: t, session: rnd() < 0.5 ? 'discord-g1' : 'discord-g2', kind: 'discord', dur: 2 + rnd() * 2 })
  for (let t = 5; t < horizon; t += 8 + rnd() * 8)
    jobs.push({ at: t, session: 'owner', kind: 'owner', dur: 1.5 + rnd() * 1.5 })
  return jobs.sort((a, b) => a.at - b.at)
}

class Slots {
  private waiting: Array<{ prio: number, seq: number, go: () => void }> = []
  private seq = 0
  constructor(private free: number, private usePriority: boolean) {}
  async acquire(prio: number) {
    if (this.free > 0) {
      this.free--
      return
    }
    await new Promise<void>(go => this.waiting.push({ prio, seq: this.seq++, go }))
  }

  release() {
    if (this.waiting.length === 0) {
      this.free++
      return
    }
    this.waiting.sort((a, b) => this.usePriority ? (a.prio - b.prio) || (a.seq - b.seq) : a.seq - b.seq)
    this.waiting.shift()!.go()
  }
}

type TimedJob = Job & { startedAt?: number, onStart?: () => void }

async function runHol(mode: 'global' | 'lanes', slots: number | undefined, usePriority: boolean, jobs: Job[], coalesce = false) {
  const waitingBySession = new Map<string, Promise<void>>()
  let merged = 0
  const t0 = performance.now()
  const now = () => (performance.now() - t0) / SCALE
  const pool = slots ? new Slots(slots, usePriority) : undefined
  const prioOf = { owner: 0, discord: 1, game: 2 } as const
  const records: Array<{ kind: Job['kind'], wait: number, total: number }> = []
  const sessions: Record<string, ChatHistoryItem[]> = {}

  function makeRuntime() {
    return createChatOrchestratorRuntime({
      session: {
        ensureSession: (id) => { sessions[id] ??= [] },
        getSessionMessages: id => sessions[id] ?? [],
        appendSessionMessage: (id, m) => { (sessions[id] ??= []).push(m) },
        getSessionGeneration: () => 1,
      },
      context: { ingest: () => {}, snapshot: () => ({}) },
      foregroundStream: { patch: () => {}, reset: () => {} },
      llm: {
        stream: async (_m, _p, _c, options) => {
          // The harness passes the job through headers so the fake port can time it.
          const job = options?.headers as unknown as TimedJob
          await pool?.acquire(prioOf[job.kind])
          job.startedAt = now()
          job.onStart?.()
          await sleep(job.dur * SCALE)
          pool?.release()
          await options?.onStreamEvent?.({ type: 'text-delta', text: 'ok' })
          await options?.onStreamEvent?.({ type: 'finish' })
        },
      },
      getActiveSessionId: () => 'owner',
      getActiveProvider: () => 'mock',
    })
  }

  const global = makeRuntime()
  const lanes = new Map<string, ReturnType<typeof makeRuntime>>()
  const laneOf = (s: string) => {
    if (mode === 'global')
      return global
    if (!lanes.has(s))
      lanes.set(s, makeRuntime())
    return lanes.get(s)!
  }

  const pending: Promise<void>[] = []
  for (const job of jobs) {
    const delay = job.at - now()
    if (delay > 0)
      await sleep(delay * SCALE)
    const arrivedAt = now()
    const queuedSame = waitingBySession.get(job.session)
    // Coalescing: a Discord request joins a queued request of the same guild that has not started.
    if (coalesce && job.kind === 'discord' && queuedSame) {
      merged++
      pending.push(queuedSame.then(() => {
        records.push({ kind: job.kind, wait: 0, total: now() - arrivedAt })
      }))
      continue
    }
    let markStarted!: () => void
    const started = new Promise<void>((r) => {
      markStarted = r
    })
    const j: TimedJob = { ...job, onStart: markStarted }
    const done = laneOf(job.session).ingest(`${job.kind} request`, {
      model: 'm',
      chatProvider: provider,
      providerConfig: { headers: j as unknown as Record<string, string> },
    }, job.session).then(() => {
      records.push({ kind: job.kind, wait: (j.startedAt ?? arrivedAt) - arrivedAt, total: now() - arrivedAt })
    })
    waitingBySession.set(job.session, done)
    void started.then(() => {
      if (waitingBySession.get(job.session) === done)
        waitingBySession.delete(job.session)
    })
    pending.push(done)
  }
  await Promise.all(pending)

  const summary: Record<string, unknown> = { mergedDiscordRequests: merged }
  for (const kind of ['owner', 'discord', 'game'] as const) {
    const rs = records.filter(r => r.kind === kind)
    summary[kind] = {
      n: rs.length,
      waitP50: +pct(rs.map(r => r.wait), 0.5).toFixed(2),
      waitP95: +pct(rs.map(r => r.wait), 0.95).toFixed(2),
      totalP95: +pct(rs.map(r => r.total), 0.95).toFixed(2),
    }
  }
  return summary as Record<string, { waitP95: number }>
}

describe('bench', () => {
  it('b1 head-of-line blocking', async () => {
    const jobs = makeWorkload(42)
    results.b1 = {
      horizonSimSeconds: 180,
      offeredLoadErlang: +(jobs.reduce((s, j) => s + j.dur, 0) / 180).toFixed(2),
      globalQueue_current: await runHol('global', undefined, false, jobs),
      lanes_unbounded: await runHol('lanes', undefined, false, jobs),
      lanes_2slots_fifo: await runHol('lanes', 2, false, jobs),
      lanes_2slots_priority: await runHol('lanes', 2, true, jobs),
      lanes_1slot_fifo: await runHol('lanes', 1, false, jobs),
      lanes_1slot_priority: await runHol('lanes', 1, true, jobs),
      lanes_1slot_priority_coalesce: await runHol('lanes', 1, true, jobs, true),
    }
    const seeds: Record<string, unknown> = {}
    for (const seed of [1, 2, 3]) {
      const w = makeWorkload(seed)
      const g = await runHol('global', undefined, false, w)
      const l = await runHol('lanes', 2, true, w)
      const c = await runHol('lanes', 1, true, w, true)
      seeds[seed] = { ownerWaitP95_global: g.owner.waitP95, ownerWaitP95_lanes2prio: l.owner.waitP95, ownerWaitP95_1slotPrioCoalesce: c.owner.waitP95, gameWaitP95_1slotPrioCoalesce: c.game.waitP95 }
    }
    results.b1seeds = seeds
  }, 300_000)

  // Bench 2: growth of the [Context] block over one simulated hour.
  it('b2 context growth', () => {
    const registry = createContextRegistry()
    // Same shape as buildStatusText() in integrations/minecraft/src/airi/minecraft-context-service.ts.
    const statusText = [
      'Bot online: airi_bot',
      'Desktop command relay: available.',
      'When the user asks to instruct or control this Minecraft bot, call the builtIn_emitSparkCommand tool.',
      'Set destinations to ["minecraft-bot"], set intent to "action", and put the user\'s Minecraft instruction in guidance.options[0].label and guidance.options[0].steps.',
      'Do not claim that an instruction was relayed unless the tool call succeeds.',
      'Server: localhost:25565',
      'Position: x: 12.3, y: 64.0, z: -88.1',
      'Health: 18/20, Mode: survival',
      'Other players online: owner_player',
      'Master (your owner) in-game username: owner_player',
    ].join('\n')
    const mk = (source: string, strategy: 'append-self' | 'replace-self', text: string, i: number) => ({
      id: `${source}-${i}`,
      contextId: strategy === 'replace-self' ? source : `${source}-${i}`,
      strategy,
      text,
      source,
      createdAt: i,
    }) as ContextMessage
    const samples: Array<{ minute: number, entries: number, tokens: number }> = []
    for (let s = 0; s <= 3600; s++) {
      if (s % 5 === 0)
        registry.ingest(mk('minecraft-status', 'replace-self', statusText, s))
      if (s % 30 === 0)
        registry.ingest(mk('minecraft-brain', 'append-self', `Player asked for wood. Collected 12 oak logs near x:${s % 100}, heading back to base.`, s))
      if (s % 4 === 0)
        registry.ingest(mk('discord-bot', 'append-self', `The input is coming from Discord channel 1234567890${s % 7} (Guild: 98765432${s % 2}).`, s))
      if (s % 600 === 0) {
        const snap = registry.snapshot()
        const text = Object.entries(snap).flatMap(([k, ms]) => ms.map(m => `- ${k}: ${m.text}`)).join('\n')
        samples.push({ minute: s / 60, entries: Object.values(snap).flat().length, tokens: tokens(`[Context]\n${text}`) })
      }
    }
    results.b2 = { samples }
  })

  // Bench 3: compose cost and prompt size when a long session is resumed.
  it('b3 resume cost', async () => {
    const rnd = mulberry32(7)
    const words = 'the a player owner stream chat game build plan wood stone iron sword village night creeper safe home friend music song today tomorrow'.split(' ')
    const sentence = (n: number) => Array.from({ length: n }, () => words[Math.floor(rnd() * words.length)]).join(' ')
    const rows: unknown[] = []
    for (const n of [50, 500, 2000, 5000]) {
      const history: ChatHistoryItem[] = [{ role: 'system', content: sentence(300), id: 'sys', createdAt: 0 }]
      for (let i = 0; i < n; i++) {
        history.push(i % 2
          ? { role: 'assistant', content: sentence(40), id: `a${i}`, createdAt: i * 1000, slices: [], tool_results: [] } as ChatHistoryItem
          : { role: 'user', content: sentence(20), id: `u${i}`, createdAt: i * 1000 })
      }
      let captured: Conversation | undefined
      const sessions: Record<string, ChatHistoryItem[]> = {}
      const runtime = createChatOrchestratorRuntime({
        session: {
          ensureSession: () => {},
          getSessionMessages: id => sessions[id],
          appendSessionMessage: (id, m) => { sessions[id].push(m) },
          getSessionGeneration: () => 1,
        },
        context: { ingest: () => {}, snapshot: () => ({}) },
        foregroundStream: { patch: () => {}, reset: () => {} },
        llm: {
          stream: async (_m, _p, c, options) => {
            captured = c
            await options?.onStreamEvent?.({ type: 'finish' })
          },
        },
        getActiveSessionId: () => 's',
        getActiveProvider: () => 'mock',
      })
      const times: number[] = []
      for (let r = 0; r < 12; r++) {
        sessions.s = structuredClone(history)
        const t = performance.now()
        await runtime.ingest('hello again', { model: 'm', chatProvider: provider }, 's')
        times.push(performance.now() - t)
      }
      times.splice(0, 2)
      const promptText = renderConversationPreview(captured!).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
      rows.push({ messages: n, composeMsP50: +pct(times, 0.5).toFixed(2), composeMsP95: +pct(times, 0.95).toFixed(2), promptTokens: tokens(promptText) })
    }
    results.b3 = rows
  }, 120_000)

  // Bench 4: token size of the current spark-notify LLM triage request, without the character prompt.
  it('b4 spark-notify triage prompt size', async () => {
    let conv: Conversation | undefined
    let toolJson = ''
    const agent = createSparkNotifyAgent({
      runner: {
        run: async (req) => {
          conv = req.conversation
          toolJson = JSON.stringify(req.tools.map(t => ({ type: t.type, function: t.function })))
        },
      },
    })
    await agent.handle({
      event: {
        type: 'spark:notify',
        source: 'minecraft',
        data: { id: 'n1', eventId: 'e1', kind: 'alarm', urgency: 'immediate', headline: 'Under attack by a witch', note: 'HP 6/20 near base', destinations: ['character'] },
      } as never,
      selectedChat: { providerId: 'mock', model: 'm', provider },
      systemPrompt: '',
    })
    const promptText = renderConversationPreview(conv!).map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
    results.b4 = { promptTokensWithoutCharacterPrompt: tokens(promptText), toolSchemaTokens: tokens(toolJson) }
    writeFileSync(OUT, JSON.stringify(results, null, 2))
  })
})
```
