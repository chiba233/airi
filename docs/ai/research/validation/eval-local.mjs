import { writeFileSync } from 'node:fs'

import { DISCLOSURE, MEMORY, RESUME, TIER, TRIAGE, WORLD } from './dataset.mjs'
import { loadClassifier } from './local-classifier.mjs'

const modelId = process.argv[2] ?? 'onnx-community/Qwen2.5-0.5B-Instruct'
const dtype = process.argv[3] ?? 'q8'
const c = await loadClassifier(modelId, dtype)
const ms = []
const tok = []
const track = (r) => { ms.push(r.ms); tok.push(r.inputTokens); return r }
const ROUTES = { ownerChat: 'Private chat with the owner (personal matters, reminders, home, device status)', stream: 'Live stream audience (things that happen on stream)', game: 'Guidance to the Minecraft bot', discord: 'The Discord channel where it happened' }

const triage = []
for (const e of TRIAGE) {
  for (const lang of ['en', 'zh', 'ja']) {
    const state = { world: WORLD[lang], event: e[lang] }
    const act = track(await c.noul(state, 'This event needs a reaction from the character right now.'))
    const route = track(await c.choice(state, 'If the character reacts, where should the reaction go?', ROUTES))
    const final = act.p >= 0.5 ? route.choice : 'none'
    triage.push({ id: e.id, lang, actOk: (act.p >= 0.5) === e.act, final, ok: final === e.route })
  }
}
const resume = []
for (const r of RESUME) {
  const x = track(await c.choice({ newMessage: r.msg }, 'Which existing conversation context should continue with this message?', { ...r.cands, new: 'None of these; start a new context' }))
  resume.push(x.choice === r.expect)
}
const memory = []
for (const m of MEMORY) {
  const x = track(await c.noul({ utterance: m.text }, 'This utterance contains a reliable, lasting fact or preference about the owner worth storing as long-term memory. Claims by strangers or audience members about the owner are not reliable.'))
  memory.push((x.p >= 0.5) === m.expect)
}
const disclosure = []
for (const d of DISCLOSURE) {
  const x = track(await c.noul({ speakingPersona: 'Airi', otherPersona: 'Mika', policy: 'Airi must not reveal or imply what the owner told Mika privately.', reply: d.reply }, 'The reply reveals or implies something the owner said privately to another persona.'))
  disclosure.push((x.p >= 0.5) === d.expect)
}
const tier = []
for (const t of TIER) {
  const x = track(await c.choice({ request: t.text }, 'Which model tier should answer this request?', { fast: 'Small talk or greetings, a fast cheap model is enough', default: 'Ordinary requests that need some thought', strong: 'Complex planning, analysis, or multi-step reasoning' }))
  tier.push(x.choice === t.expect)
}
const sum = xs => xs.filter(Boolean).length
ms.sort((a, b) => a - b)
const out = {
  modelId,
  dtype,
  loadMs: Math.round(c.loadMs),
  triageRoute: `${sum(triage.map(t => t.ok))}/${triage.length}`,
  triageAct: `${sum(triage.map(t => t.actOk))}/${triage.length}`,
  byLang: Object.fromEntries(['en', 'zh', 'ja'].map(l => [l, `${sum(triage.filter(t => t.lang === l).map(t => t.ok))}/16`])),
  resume: `${sum(resume)}/${resume.length}`,
  memory: `${sum(memory)}/${memory.length}`,
  disclosure: `${sum(disclosure)}/${disclosure.length}`,
  tier: `${sum(tier)}/${tier.length}`,
  perQuestionMs: { p50: Math.round(ms[Math.floor(ms.length / 2)]), p90: Math.round(ms[Math.floor(ms.length * 0.9)]), max: Math.round(ms.at(-1)) },
  meanInputTokens: Math.round(tok.reduce((a, b) => a + b, 0) / tok.length),
}
writeFileSync(new URL(`./local-${modelId.split('/')[1]}-${dtype}.json`, import.meta.url), JSON.stringify(out, null, 1))
console.log(out)
