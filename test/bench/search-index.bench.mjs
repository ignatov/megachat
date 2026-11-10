// Not part of npm test: node test/bench/search-index.bench.mjs [entries]
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MegachatSearchIndex } from '../../src/MegachatSearchIndex.mjs'

const count = Number(process.argv[2] ?? 100000)
const ru = 'иконка готическая буква сессия агент история поиск индекс задача ответ проект ветка тест сборка профилировщик'.split(' ')
const en = 'icon gothic letter session agent history search index task answer project branch test build tokprofiler daemon'.split(' ')
let seed = 42
const random = () => { // mulberry32
  seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}
const text = id => {
  const words = []
  let size = 0
  while (size < 2000) {
    // Zipf-like: a few common words, a long tail of rare ones.
    const rank = Math.floor(random() ** 3 * 40000)
    const word = rank < ru.length + en.length ? [...ru, ...en][rank] : random() < 0.5 ? `слово${rank}` : `w${rank}`
    words.push(word)
    size += word.length + 1
  }
  return `${id} ${words.join(' ')}`
}
const entry = id => ({ kind: id % 2 ? 'pi.user' : 'pi.assistant', id, conversationId: 1,
  model: [{ role: id % 2 ? 'user' : 'assistant', content: id % 3 ? text(id) : [{ type: 'text', text: text(id) }], timestamp: id }] })
const percentile = (values, p) => values.sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]

const directory = await mkdtemp(join(tmpdir(), 'megachat-search-bench-'))
const path = join(directory, 'search.sqlite')
try {
  const index = await MegachatSearchIndex.open(path, async () => ({ items: [] }))
  let data = 0
  const appends = []
  const started = performance.now()
  for (let id = 1; id <= count; id++) {
    const value = entry(id)
    data += Buffer.byteLength(JSON.stringify(value))
    const before = performance.now()
    await index.append(value)
    appends.push(performance.now() - before)
  }
  const loaded = performance.now() - started
  await index.close()
  const reopened = await MegachatSearchIndex.open(path, async () => ({ items: [] }))
  const queries = ['иконк', 'tokprof', 'гот', 'сессия агент', 'w1234', 'w39999', 'слово39998', 'daemon history', 'отсутствует']
  const results = {}
  for (const query of queries) {
    const times = []
    let hits
    for (let run = 0; run < 20; run++) {
      const before = performance.now()
      hits = (await reopened.search(query, { limit: 10 })).ids.length
      times.push(performance.now() - before)
    }
    results[query] = { hits, p95ms: +percentile(times, 0.95).toFixed(2) }
  }
  await reopened.close()
  const files = await Promise.all(['', '-wal'].map(suffix => stat(`${path}${suffix}`).then(file => file.size, () => 0)))
  const indexBytes = files[0] + files[1]
  console.log(JSON.stringify({ entries: count, dataMB: +(data / 2 ** 20).toFixed(1), indexMB: +(indexBytes / 2 ** 20).toFixed(1),
    ratio: +(indexBytes / data).toFixed(2), loadSeconds: +(loaded / 1000).toFixed(1),
    appendP50ms: +percentile(appends, 0.5).toFixed(3), appendP99ms: +percentile(appends, 0.99).toFixed(3), queries: results }, null, 2))
}
finally { await rm(directory, { force: true, recursive: true }) }
