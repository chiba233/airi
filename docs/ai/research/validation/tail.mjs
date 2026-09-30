import { writeFileSync } from 'node:fs'
import { jev } from './jev.mjs'
const q = { act: { type: 'noul', instructions: 'This event needs a reaction from the character right now.' } }
async function batch(n, conc) {
  const ms = []; let errs = 0; let i = 0
  const t0 = performance.now()
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < n) { i++; try { ms.push((await jev({ event: `Stream: viewer #${i} says hi` }, q, { retries: 0 })).ms) } catch { errs++ } }
  }))
  ms.sort((a, b) => a - b)
  const p = x => Math.round(ms[Math.min(ms.length - 1, Math.floor(x * (ms.length - 1)))])
  return { n, conc, ok: ms.length, errs, p50: p(.5), p90: p(.9), p99: p(.99), max: Math.round(ms.at(-1)), over800: ms.filter(x => x > 800).length, wallMs: Math.round(performance.now() - t0) }
}
const out = [await batch(60, 1), await batch(60, 4), await batch(60, 10)]
writeFileSync(new URL('./tail.json', import.meta.url), JSON.stringify(out))
console.log(out)
