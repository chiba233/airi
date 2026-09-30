// All-model routing prototype over the model-bank catalog, and wallet cost per hour for concurrent sub-agents.
import { readFileSync, writeFileSync } from 'node:fs'

const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url))).filter(m => m.cur === 'USD')
// Only providers a typical AIRI user configures. The router picks across all of their models.
const CONFIGURED = new Set(['openai', 'anthropic', 'google', 'deepseek', 'openrouter', 'moonshot', 'zhipu', 'qwen'])
const pool = catalog.filter(m => CONFIGURED.has(m.provider) && (m.in > 0 || m.out > 0))
const STRONG_CORE = process.argv[2] === 'strong'


// Quality is not in the catalog. Proxy tier by output price: this is the weakest link and is labeled as such.
const tierOf = m => m.out >= 8 ? 'strong' : m.out >= 1.5 ? 'default' : 'fast'
const TIER_RANK = { fast: 0, default: 1, strong: 2 }

// Workloads of the concurrent scenario. Token sizes use the measured numbers where available.
// calls/hour and output sizes are assumptions, stated in the report.

const WORKLOADS = [
  { id: 'chat-reply', agent: 'conversation', callsPerHour: 60, inTok: 16_000, stablePrefix: 0.85, outTok: 150, need: { fc: true, ctx: 32_000, minTier: 'default' } },
  { id: 'game-plan', agent: 'minecraft', callsPerHour: 120, inTok: 8_000, stablePrefix: 0.7, outTok: 400, need: { fc: true, reasoning: true, ctx: 64_000, minTier: 'default' } },
  { id: 'stream-commentary', agent: 'stream', callsPerHour: 120, inTok: 4_000, stablePrefix: 0.8, outTok: 60, need: { ctx: 16_000, minTier: 'fast' } },
  { id: 'memory-digest', agent: 'background', callsPerHour: 4, inTok: 60_000, stablePrefix: 0, outTok: 300, need: { ctx: 128_000, minTier: 'fast' } },
  { id: 'screen-look', agent: 'vision', callsPerHour: 12, inTok: 2_000, stablePrefix: 0.5, outTok: 150, need: { vision: true, ctx: 16_000, minTier: 'fast' } },
]
if (process.argv[2] === 'strong') for (const w of WORKLOADS) if (w.agent === 'conversation' || w.agent === 'minecraft') w.need.minTier = 'strong'
const JEV = { callsPerHour: 1_000, inTok: 400, pricePerM: 0.042 }

function eligible(m, need) {
  return (!need.fc || m.fc) && (!need.vision || m.vision) && (!need.reasoning || m.reasoning) && m.ctx >= need.ctx && TIER_RANK[tierOf(m)] >= TIER_RANK[need.minTier]
}
function callCost(m, w, cache) {
  const cachedIn = cache && m.cachedIn != null ? w.inTok * w.stablePrefix : 0
  const freshIn = w.inTok - cachedIn
  return (freshIn * m.in + cachedIn * (m.cachedIn ?? m.in) + w.outTok * m.out) / 1e6
}
function route(w, cache) {
  const c = pool.filter(m => eligible(m, w.need))
  // Cheapest eligible model at the required tier or above.
  return c.sort((a, b) => callCost(a, w, cache) - callCost(b, w, cache))[0]
}

const strongBaseline = pool.find(m => m.provider === 'anthropic' && /sonnet-4-5/.test(m.id)) ?? pool.filter(m => tierOf(m) === 'strong').sort((a, b) => b.out - a.out)[0]
const jevHour = JEV.callsPerHour * JEV.inTok * JEV.pricePerM / 1e6
const rows = []
let single = 0; let routed = 0; let routedCache = 0
for (const w of WORKLOADS) {
  const r = route(w, false); const rc = route(w, true)
  const s = callCost(strongBaseline, w, false) * w.callsPerHour
  const a = callCost(r, w, false) * w.callsPerHour
  const b = callCost(rc, w, true) * w.callsPerHour
  single += s; routed += a; routedCache += b
  rows.push({ workload: w.id, routedPrice: `in ${r.in} / out ${r.out} / cached ${r.cachedIn ?? '-'}`, eligibleModels: pool.filter(m => eligible(m, w.need)).length, routedTo: `${r.provider}/${r.id}`, routedWithCacheTo: `${rc.provider}/${rc.id}`, singleModelUsdPerHour: +s.toFixed(3), routedUsdPerHour: +a.toFixed(3), routedCacheUsdPerHour: +b.toFixed(3) })
}
const out = {
  poolSize: pool.length,
  poolWithCachePrice: pool.filter(m => m.cachedIn != null).length,
  strongBaseline: `${strongBaseline.provider}/${strongBaseline.id} in=${strongBaseline.in} out=${strongBaseline.out} cached=${strongBaseline.cachedIn}`,
  rows,
  totals: { singleStrongModel: +(single + jevHour).toFixed(2), routed: +(routed + jevHour).toFixed(2), routedWithCache: +(routedCache + jevHour).toFixed(2), jevTriagePerHour: +jevHour.toFixed(3) },
}
writeFileSync(new URL(`./route-cost-${process.argv[2] ?? 'default'}.json`, import.meta.url), JSON.stringify(out, null, 1))
console.log(JSON.stringify(out, null, 1))
