import { writeFileSync } from 'node:fs'
import { TRIAGE, WORLD } from './dataset.mjs'
import { loadClassifier } from './local-classifier.mjs'
const [modelId, dtype] = [process.argv[2], process.argv[3]]
const c = await loadClassifier(modelId, dtype)
const rows = []
for (const e of TRIAGE) for (const lang of ['en', 'zh', 'ja']) {
  const r = await c.noul({ world: WORLD[lang], event: e[lang] }, 'This event needs a reaction from the character right now.')
  rows.push({ id: e.id, lang, y: e.act, p: r.p })
}
// AUC by pair counting, and accuracy at the best threshold (optimistic, same data) and at a 2-fold threshold.
const pos = rows.filter(r => r.y), neg = rows.filter(r => !r.y)
let wins = 0; for (const a of pos) for (const b of neg) wins += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0
const auc = wins / (pos.length * neg.length)
const accAt = (t, xs) => xs.filter(r => (r.p >= t) === r.y).length / xs.length
const ths = [...new Set(rows.map(r => r.p))].sort((a, b) => a - b)
const best = ths.reduce((b, t) => accAt(t, rows) > accAt(b, rows) ? t : b, 0.5)
// 2-fold: tune on en, test on zh+ja
const en = rows.filter(r => r.lang === 'en'), rest = rows.filter(r => r.lang !== 'en')
const tEn = [...new Set(en.map(r => r.p))].reduce((b, t) => accAt(t, en) > accAt(b, en) ? t : b, 0.5)
const out = { modelId, auc: +auc.toFixed(3), acc05: +accAt(0.5, rows).toFixed(3), bestT: +best.toFixed(4), accBest: +accAt(best, rows).toFixed(3), tunedOnEn: +tEn.toFixed(4), accZhJaWithEnThreshold: +accAt(tEn, rest).toFixed(3), pRange: [Math.min(...rows.map(r => r.p)).toFixed(4), Math.max(...rows.map(r => r.p)).toFixed(4)] }
writeFileSync(new URL(`./auc-${modelId.split('/')[1]}.json`, import.meta.url), JSON.stringify({ out, rows }))
console.log(out)
