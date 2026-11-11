// Not part of npm test: node test/bench/session-index.bench.mjs [entries]
// Writes a synthetic corpus of Claude Code, Codex and pi sessions into a temporary home, imports it with the session
// index, and measures the import time, the longest block of the event loop during the import, and the search latency.
// KEEP=1 keeps the temporary home and prints its path, for a study of the queries.
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { SessionIndexService } from '../../src/SessionIndexService.mjs'

const count = Number(process.argv[2] ?? 100000)
const perSession = 200
const ru = 'иконка готическая буква сессия агент история поиск индекс задача ответ проект ветка тест сборка профилировщик'.split(' ')
const en = 'icon gothic letter session agent history search index task answer project branch test build tokprofiler daemon'.split(' ')
let seed = 42
const random = () => { // mulberry32
  seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}
const text = (id, size) => {
  const words = []
  let length = 0
  while (length < size) {
    // Zipf-like: a few common words, a long tail of rare ones.
    const rank = Math.floor(random() ** 3 * 40000)
    const word = rank < ru.length + en.length ? [...ru, ...en][rank] : random() < 0.5 ? `слово${rank}` : `w${rank}`
    words.push(word)
    length += word.length + 1
  }
  return `${id} ${words.join(' ')}`
}
const percentile = (values, p) => values.sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]
const iso = time => new Date(time).toISOString()

const home = await mkdtemp(join(tmpdir(), 'megachat-sessions-bench-'))
const projects = ['alpha', 'beta', 'gamma'].map(name => join(home, 'src', name))
try {
  for (const project of projects) await mkdir(project, { recursive: true })
  let data = 0
  const now = Date.now()
  const sessions = Math.ceil(count / perSession)
  for (let session = 0; session < sessions; session++) {
    const agent = ['claude', 'codex', 'pi'][session % 3]
    // The agents and the projects do not go together, so each scope of a search holds a part of the sessions.
    const cwd = projects[Math.floor(session / 3) % projects.length]
    const lines = []
    const id = `bench-${session}`
    const time = index => iso(now - (sessions - session) * 60000 + index)
    if (agent === 'codex') lines.push({ type: 'session_meta', timestamp: time(0), payload: { id, cwd, timestamp: time(0), base_instructions: { text: 'x'.repeat(18000) } } })
    if (agent === 'pi') lines.push({ type: 'session', version: 3, id, cwd, timestamp: time(0) })
    for (let index = 0; index < perSession; index++) {
      // Each tenth entry is a large tool output that the index cuts to about 2 KB.
      const body = text(`${session}.${index}`, index % 10 === 9 ? 20000 : 1500)
      const role = index % 2 ? 'assistant' : 'user'
      if (agent === 'claude') lines.push({ type: role, uuid: `${id}-${index}`, cwd, sessionId: id, timestamp: time(index), message: { role, content: body } })
      if (agent === 'codex') lines.push({ type: 'response_item', timestamp: time(index),
        payload: { type: 'message', role, id: `${id}-${index}`, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: body }] } })
      if (agent === 'pi') lines.push({ type: 'message', id: `e${index}`, timestamp: time(index), message: { role, content: [{ type: 'text', text: body }] } })
    }
    const content = lines.map(line => `${JSON.stringify(line)}\n`).join('')
    data += Buffer.byteLength(content)
    const directory = agent === 'claude' ? join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
      : agent === 'codex' ? join(home, '.codex', 'sessions', '2026', '11', '10') : join(home, '.pi', 'agent', 'sessions', `--${cwd.slice(1).replace(/\//g, '-')}--`)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, agent === 'codex' ? `rollout-2026-11-10T10-00-00-${id}.jsonl` : `${id}.jsonl`), content)
  }

  const value = { megachatWorkspace: null, workspaces: [projects[0]], projects: projects.slice(1) }
  const state = { snapshot: async () => value, watch: async () => ({ value, start() {}, stop: async () => {} }),
    sessionsTask: async () => {}, sessionsIndexed: async () => {}, sessionsOff: async () => {} }
  const path = join(home, 'sessions.sqlite')
  const service = new SessionIndexService({ path, state, home, environment: {}, watch: () => ({ close() {}, on() {} }) })
  // Two measures of a block: the delay histogram of Node.js, and the largest gap between ticks of a 1 ms timer.
  const histogram = monitorEventLoopDelay({ resolution: 1 })
  let last = performance.now()
  let longest = 0
  const ticker = setInterval(() => { const time = performance.now(); longest = Math.max(longest, time - last); last = time }, 1)
  histogram.enable()
  const started = performance.now()
  await service.apply({ 'sessions.index': 'on', 'sessions.days': 0 })
  await service.idle()
  const imported = performance.now() - started
  histogram.disable()
  clearInterval(ticker)

  const counts = await service.store.counts()
  const queries = ['иконк', 'tokprof', 'гот', 'сессия агент', 'w1234', 'w39999', 'слово39998', 'daemon history', 'отсутствует']
  const results = {}
  for (const query of queries) {
    const times = []
    let hits
    for (let run = 0; run < 20; run++) {
      const before = performance.now()
      hits = (await service.store.search('claude', projects[0], query.split(' '))).hits.length
      times.push(performance.now() - before)
    }
    results[query] = { hits, p95ms: +percentile(times, 0.95).toFixed(2) }
  }
  await service.close()
  const files = await Promise.all(['', '-wal'].map(suffix => stat(`${path}${suffix}`).then(file => file.size, () => 0)))
  console.log(JSON.stringify({ entries: counts.entries, sessions: counts.sessions, dataMB: +(data / 2 ** 20).toFixed(1),
    indexMB: +((files[0] + files[1]) / 2 ** 20).toFixed(1), importSeconds: +(imported / 1000).toFixed(1),
    longestBlockMs: +(longest - 1).toFixed(1), delayMaxMs: +(histogram.max / 1e6).toFixed(1), delayP99Ms: +(histogram.percentile(99) / 1e6).toFixed(1),
    queries: results }, null, 2))
}
finally { if (process.env.KEEP) console.log(home); else await rm(home, { force: true, recursive: true }) }
