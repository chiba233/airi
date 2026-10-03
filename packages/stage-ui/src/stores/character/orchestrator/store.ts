import type { DueRecipe } from '@proj-airi/core-agent'
import type { SparkNotifyResponseControl } from '@proj-airi/core-agent/agents/spark-notify'
import type { WebSocketBaseEvent, WebSocketEventOf, WebSocketEvents } from '@proj-airi/server-sdk'
import type { SyncedPiniaRuntime } from 'pinia-plugin-synced'

import { errorMessageFrom } from '@moeru/std'
import { dueTriggeredRecipes, OWNER_AUDIENCE, OWNER_PRIVATE_BINDING } from '@proj-airi/core-agent'
import { createSparkNotifyAgent, createSparkNotifyReactionPlugin } from '@proj-airi/core-agent/agents/spark-notify'
import { defineStore, storeToRefs } from 'pinia'
import { onScopeDispose, ref } from 'vue'

import { useCharacterNotebookStore, useCharacterStore } from '../'
import { useAiriRuntimePrompt } from '../../../composables/use-airi-runtime-prompt'
import { getEventSourceKey } from '../../../utils/event-source'
import { useLLM } from '../../ai/chat-llm/llm'
import { useChatStore } from '../../chat'
import { useChatContextStore } from '../../chat/context-store'
import { useChatSessionStore } from '../../chat/session-store'
import { useModsServerChannelStore } from '../../mods/api/channel-server'
import { useAiriCardStore } from '../../modules/airi-card'
import { useConsciousnessStore } from '../../modules/consciousness'
import { useTriageStore } from '../../modules/triage'
import { useRecipesStore } from '../../recipes'
import { useCharacterMoodStore } from '../mood'

export { sparkNotifyCommandSchema } from '@proj-airi/core-agent/agents/spark-notify'

export const useCharacterOrchestratorStore = defineStore('character-orchestrator', () => {
  const { stream } = useLLM()
  const consciousnessStore = useConsciousnessStore()
  const { activeProvider, activeModel } = storeToRefs(consciousnessStore)
  const characterStore = useCharacterStore()
  const notebookStore = useCharacterNotebookStore()
  const { systemPrompt } = storeToRefs(characterStore)
  const runtimePrompt = useAiriRuntimePrompt()
  const modsServerChannelStore = useModsServerChannelStore()
  const chatSession = useChatSessionStore()
  const chatContext = useChatContextStore()
  const mood = useCharacterMoodStore()
  const airiCard = useAiriCardStore()
  const triage = useTriageStore()
  const recipes = useRecipesStore()

  const processing = ref(false)
  const pendingNotifies = ref<Array<WebSocketEventOf<'spark:notify'>>>([])

  const scheduledNotifies = ref<Array<{
    event: WebSocketEventOf<'spark:notify'>
    control?: SparkNotifyResponseControl
    enqueuedAt: number
    nextRunAt: number
    attempts: number
    maxAttempts: number
    reason?: string
  }>>([])

  const attentionConfig = ref({
    tickIntervalMs: 2_000,
    taskNotifyWindowMs: 60_000,
    requeueDelayMs: 30_000,
    maxAttempts: 3,
  })

  let tickTimer: ReturnType<typeof setInterval> | undefined
  let initialized = false
  let leadership: SyncedPiniaRuntime | undefined
  let stopLeadershipListener: (() => void) | undefined
  const eventUnsubscribes: Array<() => void> = []
  const sparkNotifyAgent = createSparkNotifyAgent({
    runner: {
      run: request => stream(
        request.selectedChat.model,
        request.selectedChat.provider,
        request.conversation,
        {
          tools: request.tools,
          providerId: request.selectedChat.providerId,
          supportsTools: request.policy.supportsTools,
          waitForTools: request.policy.waitForTools,
          toolChoice: request.policy.toolChoice,
          onStreamEvent: request.onStreamEvent,
        },
      ),
    },
    plugins: [
      createSparkNotifyReactionPlugin({
        onDelta: (eventId, text) => characterStore.onSparkNotifyReactionStreamEvent(eventId, text),
        onEnd: (eventId, text) => characterStore.onSparkNotifyReactionStreamEnd(eventId, text),
      }),
    ],
  })

  function computeNextRunAt(event: WebSocketEventOf<'spark:notify'>, attempts: number) {
    const now = Date.now()
    const baseDelay = (() => {
      switch (event.data.urgency) {
        case 'immediate':
          return 0
        case 'soon':
          return 10_000
        case 'later':
          return 60_000
        default:
          return 30_000
      }
    })()

    return now + baseDelay + (attempts * attentionConfig.value.requeueDelayMs)
  }

  function removePending(eventId: string) {
    pendingNotifies.value = pendingNotifies.value.filter(item => item.data.id !== eventId)
  }

  function enqueueSparkNotify(
    event: WebSocketEventOf<'spark:notify'>,
    options?: {
      reason?: string
      nextRunAt?: number
      maxAttempts?: number
      control?: SparkNotifyResponseControl
    },
  ) {
    if (!pendingNotifies.value.some(item => item.data.id === event.data.id)) {
      pendingNotifies.value.push(event)
    }

    scheduledNotifies.value.push({
      event,
      control: options?.control,
      enqueuedAt: Date.now(),
      nextRunAt: options?.nextRunAt ?? computeNextRunAt(event, 0),
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? attentionConfig.value.maxAttempts,
      reason: options?.reason,
    })
  }

  async function processSparkNotify(event: WebSocketEventOf<'spark:notify'>, control?: SparkNotifyResponseControl) {
    const providerId = activeProvider.value
    const model = activeModel.value
    if (!providerId || !model) {
      console.warn('Spark notify ignored: missing active provider or model')
      return undefined
    }

    const provider = await consciousnessStore.getChatProviderInstance(providerId)
    processing.value = true

    try {
      const result = await sparkNotifyAgent.handle({
        event,
        selectedChat: {
          providerId,
          model,
          provider,
        },
        systemPrompt: systemPrompt.value,
        runtimePrompt: runtimePrompt.value,
        control,
      })
      if (!result.commands.length)
        return result

      for (const command of result.commands) {
        modsServerChannelStore.send({
          type: 'spark:command',
          data: command,
        })
      }

      return result
    }
    finally {
      processing.value = false
    }
  }

  async function handleIncomingSparkNotify(event: WebSocketEventOf<'spark:notify'>, control?: SparkNotifyResponseControl) {
    if (event.data.urgency === 'immediate' && !processing.value) {
      return await processSparkNotify(event, control)
    }

    enqueueSparkNotify(event, { reason: 'spark:notify', control })
    return undefined
  }

  async function handleSparkNotifyWithReaction(
    event: WebSocketEventOf<'spark:notify'>,
    options?: SparkNotifyResponseControl & { fallbackText?: string },
  ) {
    await handleIncomingSparkNotify(event, options)

    const reaction = [...characterStore.reactions]
      .reverse()
      .find(item => item.sourceEventId === event.data.id)
      ?.message
      ?.trim()

    return reaction || options?.fallbackText || ''
  }

  function enqueueDueTasks(now: number) {
    const dueTasks = notebookStore.getDueTasks(now, attentionConfig.value.taskNotifyWindowMs)
    if (!dueTasks.length)
      return

    for (const task of dueTasks) {
      const event: WebSocketEventOf<'spark:notify'> = {
        type: 'spark:notify',
        source: 'character:task-scheduler',
        data: {
          id: `task-${task.id}`,
          eventId: task.id,
          kind: 'reminder',
          urgency: task.priority === 'critical' ? 'immediate' : 'soon',
          headline: `Task reminder: ${task.title}`,
          note: task.details,
          destinations: ['character'],
          payload: {
            taskId: task.id,
            dueAt: task.dueAt,
            priority: task.priority,
          },
        },
      }

      enqueueSparkNotify(event, { reason: 'task:due' })
      notebookStore.markTaskNotified(task.id, now + attentionConfig.value.requeueDelayMs)
    }
  }

  /** The persona of a session. A session without one uses the selected card. */
  function personaOf(sessionId: string) {
    return chatSession.sessionMetas[sessionId]?.characterId || airiCard.activeCardId || 'default'
  }

  /** Moves the persona's mood after an interaction. It runs beside the conversation and never delays it. */
  function appraiseMood(personaId: string, interaction: string) {
    if (!mood.active)
      return
    const card = airiCard.getCard(personaId)
    void mood.appraise(personaId, { persona: [card?.description, card?.personality].filter(Boolean).join('\n'), interaction }).catch((error) => {
      console.warn('[character-orchestrator] Mood appraisal failed:', errorMessageFrom(error))
    })
  }

  let triggersStartedAt: number | undefined
  const triggerFiredAt: Record<string, number> = {}

  /** Latest observation per registered source that the owner scene can read. Event triggers follow these. */
  function latestObservations() {
    const snapshot = chatContext.getContextsSnapshot({ ids: [chatSession.activeSessionId, 'character', OWNER_PRIVATE_BINDING], audience: OWNER_AUDIENCE })
    const latest: Record<string, { createdAt: number, text: string }> = {}
    for (const message of Object.values(snapshot).flat()) {
      const source = getEventSourceKey(message)
      if (!latest[source] || message.createdAt > latest[source].createdAt)
        latest[source] = { createdAt: message.createdAt, text: message.text }
    }
    return latest
  }

  /** The task a triggered recipe receives: why it started, with the observation that fired an event trigger. */
  function triggerTask(due: DueRecipe, silentMinutes: number, now: number) {
    const time = `Local time: ${new Date(now).toLocaleString()}.`
    if (due.trigger.kind === 'idle')
      return `${time} The owner has sent no message for ${silentMinutes} minutes.`
    if (due.trigger.kind === 'event' && due.observation)
      return `${time} New observation from ${due.observation.source}: ${due.observation.text}`
    return `${time} Your scheduled time came.`
  }

  /**
   * Starts the owner's auto-run recipes whose trigger is due. Each one runs in its own session without voice.
   * Its result returns to the active owner conversation, which decides what to say. Without a due recipe, nothing is asked or called.
   */
  async function runRecipeTriggers(now: number) {
    triggersStartedAt ??= now
    const parentSessionId = chatSession.activeSessionId
    const lastOwnerMessageAt = chatSession.getSessionMessagesIfLoaded(parentSessionId)?.findLast(message => message.role === 'user')?.createdAt
    const due = dueTriggeredRecipes(recipes.recipes, { now, startedAt: triggersStartedAt, lastOwnerMessageAt, firedAt: triggerFiredAt, observations: latestObservations() })
    if (!due.length)
      return
    // A trigger fires once whether its gate allows the run or not, so a gate never asks again in the same period.
    for (const entry of due)
      triggerFiredAt[entry.recipe.id] = now
    const silentMinutes = Math.round((now - (lastOwnerMessageAt ?? triggersStartedAt)) / 60_000)
    const scene = [
      `Local time: ${new Date(now).toLocaleString()}. The owner's last message was ${silentMinutes} minutes ago.`,
      ...due.flatMap(entry => entry.observation ? [`New observation from ${entry.observation.source}: ${entry.observation.text}`] : []),
    ].join('\n')
    const allowed = new Set((await triage.passRecipeGates(due.map(entry => entry.recipe), scene)).map(recipe => recipe.id))
    for (const entry of due.filter(entry => allowed.has(entry.recipe.id)))
      await useChatStore().startRecipe(entry.recipe, { parentSessionId, task: triggerTask(entry, silentMinutes, now) })
  }

  async function tick() {
    if (!leadership?.isLeader() || processing.value)
      return

    const now = Date.now()
    enqueueDueTasks(now)
    await runRecipeTriggers(now)

    const nextIndex = scheduledNotifies.value.findIndex(item => item.nextRunAt <= now)
    if (nextIndex < 0)
      return

    const [next] = scheduledNotifies.value.splice(nextIndex, 1)
    removePending(next.event.data.id)

    try {
      await processSparkNotify(next.event, next.control)
    }
    catch (error) {
      if (next.attempts + 1 < next.maxAttempts) {
        scheduledNotifies.value = [...scheduledNotifies.value, {
          ...next,
          attempts: next.attempts + 1,
          nextRunAt: computeNextRunAt(next.event, next.attempts + 1),
        }]
        pendingNotifies.value = [...pendingNotifies.value, next.event]
      }
      else {
        console.warn('Dropped spark:notify after max attempts:', error)
      }
    }
  }

  function startTicker() {
    if (tickTimer)
      return

    tickTimer = setInterval(() => {
      void tick()
    }, attentionConfig.value.tickIntervalMs)
  }

  function stopTicker() {
    if (!tickTimer)
      return

    clearInterval(tickTimer)
    tickTimer = undefined
  }

  async function handleSparkEmit(_: WebSocketBaseEvent<'spark:emit', WebSocketEvents['spark:emit']>) {
    // Currently no-op
    return undefined
  }

  // Only the leader renderer handles notifications, triggers, and mood, so several windows never do the same work twice.
  function startConsumers() {
    if (eventUnsubscribes.length)
      return

    eventUnsubscribes.push(
      modsServerChannelStore.onEvent('spark:notify', async (event) => {
        if (!leadership?.isLeader())
          return
        try {
          await handleIncomingSparkNotify(event)
        }
        catch (error) {
          console.warn('Failed to handle spark:notify event:', error)
        }
      }),
    )

    eventUnsubscribes.push(
      modsServerChannelStore.onEvent('spark:emit', async (event) => {
        if (!leadership?.isLeader())
          return
        try {
          await handleSparkEmit(event)
        }
        catch (error) {
          console.warn('Failed to handle spark:emit event:', error)
        }
      }),
    )

    // Each finished conversation turn can move the mood of its persona. A recipe's own session is work, not conversation.
    eventUnsubscribes.push(useChatStore().onChatTurnComplete(async (turn, context) => {
      if (!leadership?.isLeader() || !context.sessionId || chatSession.sessionMetas[context.sessionId]?.recipeId)
        return
      const content = context.message.content
      const owner = typeof content === 'string' ? content : Array.isArray(content) ? content.flatMap(part => part.type === 'text' ? [part.text] : []).join(' ') : ''
      appraiseMood(personaOf(context.sessionId), `Owner: ${owner}\nCharacter: ${turn.outputText}`)
    }))

    startTicker()
  }

  function stopConsumers() {
    stopTicker()

    for (const unsubscribe of eventUnsubscribes) {
      unsubscribe()
    }

    eventUnsubscribes.length = 0
  }

  /** Starts background consumers only while this renderer owns synchronized leadership. */
  function initialize(syncedPinia: SyncedPiniaRuntime) {
    if (initialized)
      return
    initialized = true
    leadership = syncedPinia
    stopLeadershipListener = syncedPinia.onLeadershipChange((isLeader) => {
      if (isLeader)
        startConsumers()
      else
        stopConsumers()
    })
  }

  function dispose() {
    stopLeadershipListener?.()
    stopLeadershipListener = undefined
    stopConsumers()
    leadership = undefined
    initialized = false
  }

  onScopeDispose(dispose)

  return {
    processing,
    pendingNotifies,
    scheduledNotifies,
    attentionConfig,

    initialize,
    startTicker,
    stopTicker,
    dispose,

    handleSparkNotify: handleIncomingSparkNotify,
    runRecipeTriggers,
    handleSparkNotifyWithReaction,
    handleSparkEmit,
  }
})
