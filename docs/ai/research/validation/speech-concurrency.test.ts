// Probe: three sub-agents speak to the user at the same time through the real speech pipeline.
// Copy to packages/pipelines-audio/src/ and run:
//   pnpm exec vitest run --config vitest.config.ts src/speech-concurrency.test.ts
import type { PlaybackItem } from './types'

import { writeFileSync } from 'node:fs'

import { describe, it } from 'vitest'

import { createSpeechPipeline } from './speech-pipeline'

const OUT = process.env.OUT ?? 'speech-concurrency.json'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function run(chatBehavior: 'queue' | 'interrupt', mcBehavior: 'queue' | 'interrupt', sparkBehavior: 'queue' | 'interrupt') {
  return new Promise<unknown>((resolve) => {
    const t0 = performance.now()
    const heard: Array<{ owner: string, text: string, at: number }> = []
    const cut: Array<{ owner: string, at: number, reason?: string }> = []
    const endListeners: Array<(e: { item: PlaybackItem<string>, endedAt: number }) => void> = []
    const interruptListeners: Array<(e: { item: PlaybackItem<string>, reason: string, interruptedAt: number }) => void> = []
    // One mouth: items play one at a time, 8ms per character.
    const queue: PlaybackItem<string>[] = []
    let playing: { item: PlaybackItem<string>, timer: ReturnType<typeof setTimeout> } | undefined
    const pump = () => {
      if (playing || queue.length === 0)
        return
      const item = queue.shift()!
      heard.push({ owner: item.ownerId ?? '?', text: item.text, at: Math.round(performance.now() - t0) })
      playing = { item, timer: setTimeout(() => {
        playing = undefined
        endListeners.forEach(l => l({ item, endedAt: Date.now() }))
        pump()
      }, item.text.length * 8) }
    }
    const stop = (pred: (i: PlaybackItem<string>) => boolean, reason: string) => {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (pred(queue[i])) {
          const [item] = queue.splice(i, 1)
          interruptListeners.forEach(l => l({ item, reason, interruptedAt: Date.now() }))
        }
      }
      if (playing && pred(playing.item)) {
        clearTimeout(playing.timer)
        const item = playing.item
        playing = undefined
        interruptListeners.forEach(l => l({ item, reason, interruptedAt: Date.now() }))
        pump()
      }
    }
    const pipeline = createSpeechPipeline<string>({
      tts: async req => req.text,
      playback: {
        schedule: (item) => {
          queue.push(item)
          pump()
        },
        stopAll: reason => stop(() => true, reason),
        stopByIntent: (intentId, reason) => stop(i => i.intentId === intentId, reason),
        stopByOwner: (ownerId, reason) => stop(i => i.ownerId === ownerId, reason),
        onStart: () => {},
        onEnd: l => endListeners.push(l),
        onInterrupt: l => interruptListeners.push(l),
        onReject: () => {},
      },
    })
    pipeline.on('onIntentCancel', (e: { intentId: string, reason?: string }) => cut.push({ owner: e.intentId.split(':')[0], at: Math.round(performance.now() - t0), reason: e.reason }))
    const say = async (owner: string, priority: 'normal' | 'high', behavior: 'queue' | 'interrupt', lines: string[], startAt: number) => {
      await sleep(startAt)
      const intent = pipeline.openIntent({ intentId: `${owner}:${Math.random()}`, ownerId: owner, priority, behavior })
      for (const line of lines) {
        intent.writeLiteral(line)
        intent.writeFlush()
        await sleep(30)
      }
      intent.end()
    }
    void say('chat', 'normal', chatBehavior, ['Oh, you are back! How was your day?', 'I was just thinking about our castle plan.', 'Want to hear what I found?'], 0)
    void say('minecraft', 'normal', mcBehavior, ['Found iron ore at the cave entrance.', 'Mining it now, three blocks left.', 'Done, heading back to base.'], 60)
    void say('spark', 'high', sparkBehavior, ['Ouch! A witch is attacking the bot!'], 200)
    setTimeout(() => {
      resolve({
        config: { chat: chatBehavior, minecraft: mcBehavior, spark: sparkBehavior },
        order: heard.map(h => `${h.at}ms ${h.owner}: ${h.text}`),
        cancelled: cut,
        minecraftFirstHeardMs: heard.find(h => h.owner === 'minecraft')?.at ?? null,
      })
    }, 4000)
  })
}

describe('concurrent sub-agents on one voice', () => {
  it('records what the user hears', async () => {
    const results = [
      await run('queue', 'queue', 'interrupt'), // today: chat queue, spark reaction interrupt + high
      await run('queue', 'queue', 'queue'),
      await run('interrupt', 'interrupt', 'interrupt'),
    ]
    writeFileSync(OUT, JSON.stringify(results, null, 1))
  }, 30_000)
})
