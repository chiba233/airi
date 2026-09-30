const D = 384
function rand(n) { const a = new Float32Array(n * D); for (let i = 0; i < a.length; i++) a[i] = Math.random() - 0.5; for (let r = 0; r < n; r++) { let s = 0; for (let j = 0; j < D; j++) s += a[r * D + j] ** 2; s = Math.sqrt(s); for (let j = 0; j < D; j++) a[r * D + j] /= s } return a }
function topk(db, n, q, k, allow) {
  const best = []
  for (let r = 0; r < n; r++) {
    if (allow && !allow(r)) continue
    let s = 0; const o = r * D
    for (let j = 0; j < D; j++) s += db[o + j] * q[j]
    if (best.length < k) { best.push([s, r]); best.sort((a, b) => a[0] - b[0]) }
    else if (s > best[0][0]) { best[0] = [s, r]; best.sort((a, b) => a[0] - b[0]) }
  }
  return best
}
const out = []
for (const n of [10_000, 100_000, 1_000_000]) {
  const db = rand(n); const q = rand(1)
  const persona = new Uint8Array(n).map(() => Math.random() < 0.5 ? 0 : 1)
  const ms = []; const msFiltered = []
  for (let i = 0; i < 7; i++) { let t = performance.now(); topk(db, n, q, 8); ms.push(performance.now() - t); t = performance.now(); topk(db, n, q, 8, r => persona[r] === 0); msFiltered.push(performance.now() - t) }
  ms.sort((a, b) => a - b); msFiltered.sort((a, b) => a - b)
  out.push({ n, memMB: Math.round(db.byteLength / 1e6), top8MsP50: +ms[3].toFixed(1), withPersonaFilterMsP50: +msFiltered[3].toFixed(1) })
}
console.log(JSON.stringify(out))
