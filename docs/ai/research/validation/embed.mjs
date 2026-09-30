import { pipeline } from '@huggingface/transformers'
const t0 = performance.now()
const [MODEL, DTYPE, PREFIX] = [process.argv[2], process.argv[3], process.argv[4] !== 'noprefix']
const embed = await pipeline('feature-extraction', MODEL, { dtype: DTYPE })
const loadMs = performance.now() - t0
const memories = [
  '主人对花生过敏。', '主人的生日是3月3日。', '主人下个月要搬去大阪工作。', '主人不喜欢吃辣。', '主人养了一只叫年糕的猫。',
  'The owner is learning Japanese te-form and ta-form.', 'The owner prefers lo-fi and city pop music.', 'The owner plays Minecraft on survival mode with a castle build.',
  'オーナーは毎朝コーヒーを飲む。', 'オーナーは雨の日が好き。',
]
const queries = [
  { q: 'query: Does the owner have any food allergies?', expect: 0 },
  { q: 'query: When is the owner\'s birthday?', expect: 1 },
  { q: 'query: オーナーはどこに引っ越すの？', expect: 2 },
  { q: 'query: Can I recommend a spicy ramen place to the owner?', expect: 3 },
  { q: 'query: 主人的宠物叫什么？', expect: 4 },
  { q: 'query: 主人在学什么语法？', expect: 5 },
  { q: 'query: オーナーの好きな音楽は？', expect: 6 },
  { q: 'query: 主人玩什么游戏？', expect: 7 },
  { q: 'query: What does the owner drink in the morning?', expect: 8 },
  { q: 'query: 主人喜欢什么天气？', expect: 9 },
]
const t1 = performance.now()
const M = await embed(memories.map(m => PREFIX ? `passage: ${m}` : m), { pooling: 'mean', normalize: true })
const batchMs = performance.now() - t1
const one = []
for (const x of queries) { const t = performance.now(); x.v = (await embed(PREFIX ? x.q : x.q.replace('query: ', ''), { pooling: 'mean', normalize: true })).data; one.push(performance.now() - t) }
const D = M.dims[1]
let hit1 = 0; let hit3 = 0
for (const x of queries) {
  const scores = memories.map((_, i) => { let s = 0; for (let j = 0; j < D; j++) s += M.data[i * D + j] * x.v[j]; return [s, i] }).sort((a, b) => b[0] - a[0])
  if (scores[0][1] === x.expect) hit1++
  if (scores.slice(0, 3).some(s => s[1] === x.expect)) hit3++
}
one.sort((a, b) => a - b)
console.log(JSON.stringify({ model: `${MODEL} ${DTYPE}`, loadMs: Math.round(loadMs), dims: D, batch10Ms: Math.round(batchMs), singleQueryMsP50: Math.round(one[5]), crossLingualTop1: `${hit1}/10`, crossLingualTop3: `${hit3}/10` }))
