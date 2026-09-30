import { readdirSync, writeFileSync } from 'node:fs'
const dir = '/home/user/airi/node_modules/.pnpm/model-bank@1.0.20260904203849_zod@4.4.3/node_modules/model-bank/dist/aiModels'
let total = 0, chat = 0, priced = 0, withCtx = 0, fc = 0, vision = 0, reasoning = 0, full = 0
const providers = {}
const all = []
for (const f of readdirSync(dir).filter(f => f.endsWith('.mjs'))) {
  const mod = await import(dir + '/' + f)
  const list = Object.values(mod).find(v => Array.isArray(v)) ?? []
  for (const m of list) {
    total++
    if (m.type !== 'chat') continue
    chat++
    const units = m.pricing?.units ?? []
    const inp = units.find(u => u.name === 'textInput'), out = units.find(u => u.name === 'textOutput')
    const p = inp && out && typeof inp.rate === 'number' && typeof out.rate === 'number'
    if (p) priced++
    if (m.contextWindowTokens) withCtx++
    if (m.abilities?.functionCall) fc++
    if (m.abilities?.vision) vision++
    if (m.abilities?.reasoning) reasoning++
    const ok = p && m.contextWindowTokens && m.abilities
    if (ok) full++
    providers[f.replace('.mjs','')] = (providers[f.replace('.mjs','')] ?? 0) + 1
    if (ok) all.push({ provider: f.replace('.mjs',''), id: m.id, in: inp.rate, out: out.rate, cur: m.pricing?.currency ?? 'USD', ctx: m.contextWindowTokens, fc: !!m.abilities?.functionCall, vision: !!m.abilities?.vision, reasoning: !!m.abilities?.reasoning, cachedIn: units.find(u => u.name === 'textInput_cacheRead')?.rate })
  }
}
writeFileSync(new URL('./catalog.json', import.meta.url), JSON.stringify(all))
console.log(JSON.stringify({ totalEntries: total, chatModels: chat, withPricing: priced, withContext: withCtx, functionCall: fc, vision, reasoning, routableFullMetadata: full, providers: Object.keys(providers).length }))
