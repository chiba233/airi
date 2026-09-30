// Minimal JEV client over OpenCode Zen (jev-1.13-free, no key).
export const JEV_URL = process.env.JEV_URL ?? 'https://opencode.ai/zen/v1/systemone'
export const JEV_MODEL = process.env.JEV_MODEL ?? 'jev-1.13-free'
export async function jev(state, questions, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const t = performance.now()
    const res = await fetch(JEV_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: JEV_MODEL, state, questions }) })
    const ms = performance.now() - t
    const text = await res.text()
    if (res.ok) return { ...JSON.parse(text), ms }
    if (attempt >= retries) throw new Error(`JEV ${res.status}: ${text.slice(0, 300)}`)
    await new Promise(r => setTimeout(r, 1000 * 2 ** attempt))
  }
}
