// Prototype cognitive scheduler over the real core-agent runtime.
// Deliberately crude: it exists to test whether the design holds, not to ship.
import type { GenerationProvider } from '@proj-airi/provider-inference'

import type { ChatHistoryItem, ContextMessage, StreamEvent, StreamOptions } from '../index'

import { createChatOrchestratorRuntime } from '../index'

export const provider: GenerationProvider = {
  generation: model => ({ protocol: 'chat-completions', config: { model, baseURL: 'https://example.com/' } }),
}

// ---------- Lineage store (extended session meta) ----------
export type ContextStatus = 'idle' | 'active' | 'dormant' | 'retired'
export interface AgentContext {
  id: string
  personaId: string
  bindings: string[]
  parentContextId?: string
  status: ContextStatus
  digest?: string
  lastRunAt: number
  generation: number
  messages: ChatHistoryItem[]
}

export class ContextStore {
  contexts = new Map<string, AgentContext>()
  private seq = 0
  create(personaId: string, bindings: string[], parentContextId?: string): AgentContext {
    const parent = parentContextId ? this.contexts.get(parentContextId) : undefined
    const ctx: AgentContext = {
      id: `ctx-${++this.seq}`,
      personaId,
      bindings,
      parentContextId,
      status: 'idle',
      lastRunAt: 0,
      generation: 1,
      // A child starts from the parent digest, never from the full parent history.
      messages: parent?.digest ? [{ role: 'system', content: `Parent context digest: ${parent.digest}`, id: `seed-${this.seq}` }] : [],
    }
    this.contexts.set(ctx.id, ctx)
    return ctx
  }

  findByBinding(personaId: string, binding: string) {
    return [...this.contexts.values()].find(c => c.personaId === personaId && c.status !== 'retired' && c.bindings.includes(binding))
  }

  /** Resume-or-create by exact binding key. */
  resolve(personaId: string, binding: string) {
    const found = this.findByBinding(personaId, binding)
    if (found) {
      if (found.status === 'dormant')
        found.status = 'idle'
      return { ctx: found, resumed: true }
    }
    return { ctx: this.create(personaId, [binding]), resumed: false }
  }

  demoteIdle(now: number, warmMs: number, summarize: (c: AgentContext) => string) {
    for (const c of this.contexts.values()) {
      if (c.status === 'idle' && c.lastRunAt > 0 && now - c.lastRunAt > warmMs) {
        c.digest = summarize(c)
        c.status = 'dormant'
      }
    }
  }
}

// ---------- Working memory: budget, TTL, projection ----------
export interface WmEntry { slot: string, text: string, writer: string, salience: number, expiresAt: number, destinations: string[] | 'all', sourceRef?: string }
export const approxTokens = (s: string) => Math.ceil(s.length / 4)

export class WorkingMemory {
  private slots = new Map<string, WmEntry>()
  rejected = 0
  evicted = 0
  constructor(private budgetTokens: number, private maxEntryTokens: number, private now: () => number) {}
  private keep(e: WmEntry) {
    const ttl = Math.max(1, e.expiresAt - this.now())
    return e.salience * Math.min(1, ttl / 60_000)
  }

  private used() {
    return [...this.slots.values()].reduce((s, e) => s + approxTokens(e.text), 0)
  }

  gc() {
    for (const [k, e] of this.slots) {
      if (e.expiresAt <= this.now())
        this.slots.delete(k)
    }
  }

  write(e: WmEntry): boolean {
    this.gc()
    if (approxTokens(e.text) > this.maxEntryTokens) {
      this.rejected++
      return false
    }
    this.slots.delete(e.slot) // replace-self semantics per slot
    while (this.used() + approxTokens(e.text) > this.budgetTokens) {
      const victim = [...this.slots.values()].sort((a, b) => this.keep(a) - this.keep(b))[0]
      if (!victim || this.keep(victim) >= this.keep(e)) {
        this.rejected++
        return false
      }
      this.slots.delete(victim.slot)
      this.evicted++
    }
    this.slots.set(e.slot, e)
    return true
  }

  project(reader: string): ContextMessage[] {
    this.gc()
    return [...this.slots.values()]
      .filter(e => e.destinations === 'all' || e.destinations.includes(reader))
      .map(e => ({ id: e.slot, contextId: e.slot, strategy: 'replace-self', text: e.text, source: e.writer, createdAt: 0 }) as unknown as ContextMessage)
  }

  tokensFor(reader: string) {
    return this.project(reader).reduce((s, m) => s + approxTokens(`- ${m.source}: ${m.text}`), 0)
  }
}

// ---------- Slot pool with priority and preemption ----------
export interface RunHandle { runId: string, contextId: string, priority: number, preemptible: boolean, controller: AbortController, parentRunId?: string, state: 'queued' | 'working' | 'done' | 'dropped' | 'blocked' | 'expired', children: Set<string>, steps: number, lastEventAt: number, toolHashes: string[] }

export class SlotPool {
  holders = new Set<RunHandle>()
  private waiting: Array<{ run: RunHandle, go: () => void, seq: number }> = []
  private seq = 0
  preemptions = 0
  constructor(private size: number) {}
  async acquire(run: RunHandle) {
    if (this.holders.size < this.size) {
      this.holders.add(run)
      return
    }
    // Preempt the lowest priority preemptible holder when a strictly more urgent run waits.
    const victim = [...this.holders].filter(h => h.preemptible && h.priority > run.priority).sort((a, b) => b.priority - a.priority)[0]
    if (victim) {
      this.preemptions++
      victim.controller.abort(new Error('preempted'))
    }
    await new Promise<void>(go => this.waiting.push({ run, go, seq: this.seq++ }))
    this.holders.add(run)
  }

  release(run: RunHandle) {
    this.holders.delete(run)
    this.waiting.sort((a, b) => a.run.priority - b.run.priority || a.seq - b.seq)
    const next = this.waiting.shift()
    next?.go()
  }
}

// ---------- Fake model behaviour per run ----------
export interface Script { durMs: number, stallAfterMs?: number, loopTool?: boolean, text?: string, proposeChild?: { binding: string, text: string } }

// ---------- Scheduler ----------
export interface Workload { binding: string, personaId: string, text: string, priority: number, preemptible?: boolean, source: 'user' | 'module' | 'stranger', parentRunId?: string, script: Script }

export class Scheduler {
  store = new ContextStore()
  pool: SlotPool
  wm: WorkingMemory
  runs = new Map<string, RunHandle>()
  log: string[] = []
  private runtimes = new Map<string, ReturnType<typeof createChatOrchestratorRuntime>>()
  private scripts = new Map<string, Script>()
  private runByContext = new Map<string, RunHandle>()
  private seq = 0
  private queued = new Map<string, { text: string[], promise: Promise<RunHandle> }>()
  merged = 0
  constructor(opts: { slots: number, wmBudget: number, now?: () => number, stallMs?: number, maxSteps?: number }) {
    this.pool = new SlotPool(opts.slots)
    this.wm = new WorkingMemory(opts.wmBudget, 80, opts.now ?? (() => Date.now()))
    this.stallMs = opts.stallMs ?? 200
    this.maxSteps = opts.maxSteps ?? 6
  }

  private stallMs: number
  private maxSteps: number

  private runtimeFor(ctx: AgentContext) {
    let rt = this.runtimes.get(ctx.id)
    if (rt)
      return rt
    rt = createChatOrchestratorRuntime({
      session: {
        ensureSession: () => {},
        getSessionMessages: () => ctx.messages,
        appendSessionMessage: (_id, m) => { ctx.messages.push(m) },
        getSessionGeneration: () => ctx.generation,
      },
      context: { ingest: () => {}, snapshot: () => ({ wm: this.wm.project(ctx.id) }) },
      foregroundStream: { patch: () => {}, reset: () => {} },
      llm: { stream: (_m, _p, _c, options) => this.fakeModel(ctx, options) },
      getActiveSessionId: () => '',
      getActiveProvider: () => 'mock',
    })
    this.runtimes.set(ctx.id, rt)
    return rt
  }

  /** Fake model: honours the scheduler abort signal, emits events the supervisor watches. */
  private async fakeModel(ctx: AgentContext, options?: StreamOptions) {
    const run = this.runByContext.get(ctx.id)!
    const script = this.scripts.get(run.runId)!
    const emit = async (e: StreamEvent) => {
      run.lastEventAt = performance.now()
      await options?.onStreamEvent?.(e)
    }
    const aborted = () => run.controller.signal.aborted
    const t0 = performance.now()
    while (performance.now() - t0 < script.durMs) {
      if (aborted())
        throw run.controller.signal.reason
      if (script.stallAfterMs && performance.now() - t0 > script.stallAfterMs) {
        await new Promise((_, reject) => run.controller.signal.addEventListener('abort', () => reject(run.controller.signal.reason)))
      }
      if (script.loopTool) {
        run.steps++
        const args = JSON.stringify({ query: 'where is iron' })
        run.toolHashes.push(`search:${args}`)
        await emit({ type: 'tool-call', toolCallId: `c${run.steps}`, toolName: 'search', args } as StreamEvent)
      }
      await new Promise(r => setTimeout(r, 10))
      await emit({ type: 'text-delta', text: '.' })
    }
    if (script.proposeChild)
      this.propose(run, script.proposeChild)
    await emit({ type: 'text-delta', text: script.text ?? 'done' })
    await emit({ type: 'finish' } as StreamEvent)
  }

  /** Child runs only exist through the scheduler. */
  childPromises: Promise<RunHandle>[] = []
  propose(parent: RunHandle, req: { binding: string, text: string }) {
    const parentCtx = this.store.contexts.get(parent.contextId)!
    parentCtx.digest ??= `digest of ${parentCtx.id}`
    const child = this.store.create(parentCtx.personaId, [req.binding], parentCtx.id)
    this.log.push(`admit child of ${parent.runId} into ${child.id}`)
    this.childPromises.push(this.start(child, { binding: req.binding, personaId: parentCtx.personaId, text: req.text, priority: parent.priority + 1, source: 'module', parentRunId: parent.runId, script: { durMs: 60 } }))
  }

  cancel(runId: string, reason = 'cancelled') {
    const run = this.runs.get(runId)
    if (!run)
      return
    run.controller.abort(new Error(reason))
    for (const child of run.children)
      this.cancel(child, `parent ${reason}`)
  }

  /** Supervisor tick: deterministic checks only. */
  supervise() {
    const now = performance.now()
    for (const run of this.runs.values()) {
      if (run.state !== 'working')
        continue
      if (now - run.lastEventAt > this.stallMs) {
        this.log.push(`stall ${run.runId}`)
        run.state = 'blocked'
        run.controller.abort(new Error('stalled'))
      }
      const last = run.toolHashes.slice(-3)
      if (last.length === 3 && new Set(last).size === 1) {
        this.log.push(`loop ${run.runId}`)
        run.state = 'blocked'
        run.controller.abort(new Error('loop'))
      }
      if (run.steps > this.maxSteps) {
        run.state = 'expired'
        run.controller.abort(new Error('max steps'))
      }
    }
  }

  submit(w: Workload): Promise<RunHandle> {
    const { ctx } = this.store.resolve(w.personaId, w.binding)
    // Coalesce: a background request joins a queued, not yet started request of the same context.
    const q = this.queued.get(ctx.id)
    if (q && w.source !== 'user') {
      q.text.push(w.text)
      this.merged++
      return q.promise
    }
    return this.start(ctx, w)
  }

  private async start(ctx: AgentContext, w: Workload): Promise<RunHandle> {
    const run: RunHandle = { runId: `run-${++this.seq}`, contextId: ctx.id, priority: w.priority, preemptible: w.preemptible ?? w.source !== 'user', controller: new AbortController(), parentRunId: w.parentRunId, state: 'queued', children: new Set(), steps: 0, lastEventAt: performance.now(), toolHashes: [] }
    this.runs.set(run.runId, run)
    if (w.parentRunId)
      this.runs.get(w.parentRunId)?.children.add(run.runId)
    this.scripts.set(run.runId, w.script)
    const texts = [w.text]
    let started!: () => void
    const promise = (async () => {
      await new Promise<void>((r) => { started = r })
      return run
    })()
    this.queued.set(ctx.id, { text: texts, promise })
    // One run per context at a time: a context is one line of cognition.
    while (this.runByContext.get(ctx.id)?.state === 'working')
      await new Promise(r => setTimeout(r, 5))
    await this.pool.acquire(run)
    if (this.queued.get(ctx.id)?.promise === promise)
      this.queued.delete(ctx.id)
    if (run.controller.signal.aborted) {
      this.pool.release(run)
      run.state = 'dropped'
      started()
      return run
    }
    run.state = 'working'
    run.lastEventAt = performance.now()
    ctx.status = 'active'
    this.runByContext.set(ctx.id, run)
    const onAbort = () => { ctx.generation++ } // stale generation stops runtime-side writes
    run.controller.signal.addEventListener('abort', onAbort)
    try {
      await this.runtimeFor(ctx).ingest(texts.join('\n'), { model: 'm', chatProvider: provider }, ctx.id)
      if (!run.controller.signal.aborted) {
        run.state = 'done'
        this.wm.write({ slot: `result:${ctx.id}`, text: `${ctx.id} finished: ${w.script.text ?? 'done'}`, writer: ctx.id, salience: 0.5, expiresAt: Date.now() + 60_000, destinations: run.parentRunId ? [this.runs.get(run.parentRunId)!.contextId] : 'all', sourceRef: run.runId })
      }
    }
    catch {}
    finally {
      if (run.controller.signal.aborted && run.state === 'working')
        run.state = 'dropped'
      run.controller.signal.removeEventListener('abort', onAbort)
      ctx.status = 'idle'
      ctx.lastRunAt = Date.now()
      this.pool.release(run)
      started()
    }
    // A preempted run is requeued once with its original input.
    if (run.controller.signal.reason?.message === 'preempted') {
      this.log.push(`requeue ${run.runId}`)
      ctx.generation++
      return this.start(ctx, { ...w, preemptible: false })
    }
    return run
  }
}
