// Stage design: ask route only among real destinations (no "none"); gate by act noul.
import { writeFileSync } from 'node:fs'
import { TRIAGE, WORLD } from './dataset.mjs'
import { jev } from './jev.mjs'
const q = {
  act: { type: 'noul', instructions: 'This event needs a reaction from the character right now.' },
  route: { type: 'choice', instructions: 'If the character reacts, where should the reaction go?', criteria: { ownerChat: 'Private chat with the owner (personal matters, reminders, home, device status)', stream: 'Live stream audience (things that happen on stream)', game: 'Guidance to the Minecraft bot', discord: 'The Discord channel where it happened' } },
}
const rows = []
for (const c of TRIAGE) for (const lang of ['en', 'zh', 'ja']) {
  await new Promise(r => setTimeout(r, 150))
  const r = await jev({ world: WORLD[lang], event: c[lang] }, q)
  const a = r.answers
  const reacted = a.act.noul >= 0.5
  const final = reacted ? a.route.choice : 'none'
  rows.push({ id: c.id, lang, final, ok: final === c.route, conf: a.route.confidence })
}
writeFileSync(new URL('./twostage.json', import.meta.url), JSON.stringify(rows))
const ok = rows.filter(r => r.ok).length
console.log('two-stage route accuracy', ok, '/', rows.length)
for (const r of rows) if (!r.ok) console.log(' miss', r.id, r.lang, r.final, r.conf)
