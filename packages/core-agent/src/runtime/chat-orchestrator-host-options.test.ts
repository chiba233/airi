import type { GenerationProvider } from '@proj-airi/provider-inference'

import type { Conversation } from '../messages/types'
import type { ChatHistoryItem, ChatStreamEventContext } from '../types/chat'
import type { StreamOptions } from '../types/llm'
import type { ChatOrchestratorRuntimeDeps } from './chat-orchestrator-runtime'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createChatOrchestratorRuntime } from './chat-orchestrator-runtime'
import { RUN_STALLED } from './run-supervision'

const provider: GenerationProvider = {
  generation: model => ({ protocol: 'chat-completions', config: { model, baseURL: 'https://example.com/' } }),
}

type Stream = (model: string, chatProvider: GenerationProvider, conversation: Conversation, options?: StreamOptions) => Promise<void>

function createHarness(options: Partial<Pick<ChatOrchestratorRuntimeDeps, 'getSystemPrompt' | 'decideBeforeReply'>> = {}) {
  const messages: Record<string, ChatHistoryItem[]> = {}
  const stream = vi.fn<Stream>(async (_model, _provider, _conversation, streamOptions) => {
    await streamOptions?.onStreamEvent?.({ type: 'text-delta', text: 'reply' })
    await streamOptions?.onStreamEvent?.({ type: 'finish' })
  })
  const runtime = createChatOrchestratorRuntime({
    session: {
      ensureSession: (sessionId) => {
        messages[sessionId] ??= []
      },
      getSessionMessages: sessionId => messages[sessionId] ?? [],
      appendSessionMessage: (sessionId, message) => {
        (messages[sessionId] ??= []).push(message)
      },
      commitUserMessage: async (sessionId, message) => {
        (messages[sessionId] ??= []).push(message)
        return { status: 'inserted', messageId: message.id }
      },
      getSessionGeneration: () => 1,
    },
    context: { ingest: vi.fn(), snapshot: () => ({}) },
    foregroundStream: { patch: vi.fn(), reset: vi.fn() },
    llm: { stream },
    getActiveSessionId: () => 'session-1',
    getActiveProvider: () => 'mock-provider',
    ...options,
  })
  const prompt = (call = 0) => JSON.stringify(stream.mock.calls[call]?.[2])
  return { runtime, messages, stream, prompt }
}

describe('chat orchestrator host options', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // A notice tells the conversation about earlier work. The owner never said it, so history never stores it.
  it('sends a notice after the history without storing a user turn, and marks the reply as proactive', async () => {
    const harness = createHarness()

    await harness.runtime.ingest('The task finished.', { model: 'test', chatProvider: provider, notice: { source: 'recipe:Research' } })

    expect(harness.prompt()).toContain('[Notice from recipe:Research, not a message from the owner.')
    expect(harness.messages['session-1']?.map(message => message.role)).toEqual(['assistant'])
    expect(harness.messages['session-1']?.[0]).toMatchObject({ proactive: { source: 'recipe:Research' } })
  })

  // Each persona keeps its own context. Messages shown here for a mode belong to the mode's own session.
  it('leaves messages of another persona and stored system messages out of the prompt, and reads identity per session', async () => {
    const harness = createHarness({ getSystemPrompt: sessionId => `identity of ${sessionId}` })
    harness.messages['session-1'] = [
      { role: 'system', content: 'stored identity', id: 'system' },
      { role: 'user', content: 'mode question', id: 'shown', persona: { id: 'mode:adhd', name: 'ADHD' } },
    ]

    await harness.runtime.ingest('main question', { model: 'test', chatProvider: provider })

    expect(harness.prompt()).toContain('identity of session-1')
    expect(harness.prompt()).not.toContain('stored identity')
    expect(harness.prompt()).not.toContain('mode question')
    expect(harness.prompt()).toContain('main question')
  })

  it('stores no reply for an empty answer, but keeps a reply that only called a tool', async () => {
    const harness = createHarness()
    harness.stream.mockImplementationOnce(async (_model, _provider, _conversation, streamOptions) => {
      await streamOptions?.onStreamEvent?.({ type: 'finish' })
    })
    harness.stream.mockImplementationOnce(async (_model, _provider, _conversation, streamOptions) => {
      await streamOptions?.onStreamEvent?.({ type: 'tool-call', toolCallId: 'look', toolCallType: 'function', toolName: 'look', args: '{}' })
      await streamOptions?.onStreamEvent?.({ type: 'finish' })
    })

    await harness.runtime.ingest('first', { model: 'test', chatProvider: provider })
    await harness.runtime.ingest('second', { model: 'test', chatProvider: provider })

    expect(harness.messages['session-1']?.map(message => message.role)).toEqual(['user', 'user', 'assistant'])
  })

  it('ends a send without a model call when a decision chooses silence, and records applied recipes with their hints', async () => {
    const decideBeforeReply = vi.fn<NonNullable<ChatOrchestratorRuntimeDeps['decideBeforeReply']>>()
      .mockResolvedValueOnce({ silent: { reason: 'Acknowledgements' } })
      .mockResolvedValueOnce({ hints: ['Keep it short.'], applied: ['Brevity'] })
    const harness = createHarness({ decideBeforeReply })

    await harness.runtime.ingest('thanks', { model: 'test', chatProvider: provider })
    expect(harness.stream).not.toHaveBeenCalled()

    await harness.runtime.ingest('explain', { model: 'test', chatProvider: provider })
    expect(harness.prompt()).toContain('Keep it short.')
    expect(harness.messages['session-1']?.at(-1)).toMatchObject({ role: 'assistant', recipes: ['Brevity'] })
  })

  // Only a local conversation speaks. A scene reply returns as text, and background work stays silent.
  it('gives each send its output channels', async () => {
    const harness = createHarness()
    const outputs: ChatStreamEventContext['outputs'][] = []
    harness.runtime.hooks.onBeforeSend(async (_message, context) => {
      outputs.push(context.outputs)
    })

    await harness.runtime.ingest('local', { model: 'test', chatProvider: provider })
    await harness.runtime.ingest('scene', { model: 'test', chatProvider: provider, outputTarget: 'discord-connection' }, 'scene-session')
    await harness.runtime.ingest('task', { model: 'test', chatProvider: provider, background: true }, 'recipe-session')

    expect(outputs).toEqual([['chat:owner', 'voice'], ['chat:owner', 'connection:discord-connection'], ['chat:owner']])
  })

  it('replaces the oldest history that exceeds the size budget with a count', async () => {
    const harness = createHarness()
    harness.messages['session-1'] = Array.from({ length: 6 }, (_, index): ChatHistoryItem[] => [
      { role: 'user', content: `question ${index} ${'x'.repeat(20_000)}`, id: `user-${index}` },
      { role: 'assistant', content: `answer ${index}`, id: `assistant-${index}`, slices: [], tool_results: [] },
    ]).flat()

    await harness.runtime.ingest('newest', { model: 'test', chatProvider: provider })

    expect(harness.prompt()).toContain('earlier messages of this session are not shown.')
    expect(harness.prompt()).not.toContain('question 0')
    expect(harness.prompt()).toContain('newest')
  })

  it('ends a send that stops streaming and reports the stall', async () => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.stream.mockImplementationOnce(() => new Promise<void>(() => {}))

    const send = harness.runtime.ingest('hello', { model: 'test', chatProvider: provider })
    const failed = expect(send).rejects.toThrow(RUN_STALLED)
    await vi.advanceTimersByTimeAsync(60_000)

    await failed
  })
})
