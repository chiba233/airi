// Local JEV-style classifier: one forward pass, read the probability of single-token labels.
// Same idea as pi's llama.cpp classifier (docs/llama-cpp.md): state, questions, state again, then labels.
import { AutoModelForCausalLM, AutoTokenizer } from '@huggingface/transformers'

export async function loadClassifier(modelId, dtype = 'q8') {
  const t0 = performance.now()
  const tokenizer = await AutoTokenizer.from_pretrained(modelId)
  const model = await AutoModelForCausalLM.from_pretrained(modelId, { dtype })
  const loadMs = performance.now() - t0
  const LETTERS = 'ABCDEFGHIJ'.split('')
  const labelId = s => tokenizer.encode(s, { add_special_tokens: false })[0]

  async function ask(state, question, labels) {
    const stateText = typeof state === 'string' ? state : JSON.stringify(state, null, 1)
    const options = labels.map((l, i) => `${LETTERS[i]}. ${l}`).join('\n')
    const messages = [
      { role: 'system', content: 'You answer one classification question about a state. Reply with a single option letter.' },
      { role: 'user', content: `State:\n${stateText}\n\nQuestion: ${question}\nOptions:\n${options}\n\nState again:\n${stateText}\n\nAnswer with one letter.` },
    ]
    const text = tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true })
    const inputs = tokenizer(text)
    const t = performance.now()
    const { logits } = await model(inputs)
    const ms = performance.now() - t
    const [, seq, vocab] = logits.dims
    const last = logits.data.subarray((seq - 1) * vocab, seq * vocab)
    const ids = labels.map((_, i) => labelId(LETTERS[i]))
    const raw = ids.map(id => last[id])
    const m = Math.max(...raw)
    const ex = raw.map(v => Math.exp(v - m))
    const z = ex.reduce((a, b) => a + b, 0)
    const probs = ex.map(v => v / z)
    const best = probs.indexOf(Math.max(...probs))
    return { best, probs, ms, inputTokens: inputs.input_ids.dims[1] }
  }

  const noul = async (state, statement) => {
    const r = await ask(state, `Is this statement true? "${statement}"`, ['Yes', 'No'])
    return { p: r.probs[0], ms: r.ms, inputTokens: r.inputTokens }
  }
  const choice = async (state, question, criteria) => {
    const keys = Object.keys(criteria)
    const r = await ask(state, question, keys.map(k => criteria[k]))
    return { choice: keys[r.best], conf: r.probs[r.best], ms: r.ms, inputTokens: r.inputTokens }
  }
  return { loadMs, noul, choice }
}
