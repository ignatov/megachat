import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { entryText, MegachatSearchIndex, RANK_WINDOW, snippet } from '../src/MegachatSearchIndex.mjs'

const user = (id, content) => ({ kind: 'pi.user', id, conversationId: 1, model: [{ role: 'user', content, timestamp: 1000 + id }] })
const assistant = (id, content) => ({ kind: 'pi.assistant', id, conversationId: 1, model: [{ role: 'assistant', content, timestamp: 1000 + id }] })
const toolResult = (id, text) => ({ kind: 'pi.tool-result', id, conversationId: 1,
  model: [{ role: 'toolResult', toolCallId: 't', toolName: 'agents_list', content: [{ type: 'text', text }], timestamp: 1000 + id }] })

/** A committed history that reads like `root.entries({ order: 'ascending', minEntryId })`, in pages of 2. */
function history(entries) {
  const reads = []
  const read = async (minEntryId, cursor) => {
    reads.push(minEntryId)
    const items = entries.filter(entry => entry.id >= minEntryId).sort((a, b) => a.id - b.id)
    const offset = cursor ?? 0
    return { items: items.slice(offset, offset + 2), next: offset + 2 < items.length ? offset + 2 : undefined }
  }
  return { entries, read, reads }
}

async function fixture(t, entries) {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-search-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const source = history(entries)
  const path = join(directory, 'search.sqlite')
  const index = await MegachatSearchIndex.open(path, source.read)
  t.after(() => index.close())
  return { directory, path, source, index }
}

const ids = async (index, query, options) => (await index.search(query, options)).ids

test('indexes both content shapes, tool calls and truncated tool results, and skips system entries', async t => {
  const { index } = await fixture(t, [
    user(1, 'Give Megachat its icon'),
    assistant(2, [{ type: 'text', text: 'Searching' }, { type: 'toolCall', id: 'c', name: 'agents_spawn', arguments: { prompt: 'tokprofiler run' } }]),
    toolResult(3, `${'x'.repeat(3000)} tailmarker`),
    { kind: 'pi.system', id: 4, conversationId: 1, model: [{ role: 'system', content: 'system secret' }] },
    { kind: 'air.megachat.event', id: 5, conversationId: 1, data: { type: 'children' } },
    { kind: 'pi.user', id: 6, conversationId: 1, head: 2, model: [] },
  ])
  assert.equal(await index.catchUp(), 6)
  assert.deepEqual(await ids(index, 'megachat'), [1])
  assert.deepEqual(await ids(index, 'TOKPROF'), [2])
  assert.deepEqual(await ids(index, 'agents_spawn'), [2])
  assert.deepEqual(await ids(index, 'xxxx'), [3])
  assert.deepEqual(await ids(index, 'tailmarker'), [], 'Tool results are indexed up to 2 KB')
  assert.deepEqual(await ids(index, 'secret'), [])
  assert.equal(await index.lastEntryId(), 6)
  assert.equal(entryText(toolResult(3, 'y'.repeat(3000)), { full: true }).text.length, 3000)
})

test('finds Russian and English substrings regardless of case and ё', async t => {
  const { index } = await fixture(t, [
    user(1, 'Дай Megachat готическую ИКОНКУ M'),
    assistant(2, 'Запустил tokprof на ёлке'),
    assistant(3, 'Иконка готова, иконки в ресурсах'),
  ])
  await index.catchUp()
  assert.deepEqual(new Set(await ids(index, 'иконк')), new Set([1, 3]))
  assert.deepEqual(await ids(index, 'иконк megachat'), [1], 'Every term must match')
  assert.deepEqual(await ids(index, 'елке'), [2])
  assert.deepEqual(await ids(index, 'Tokprof'), [2])
  assert.equal(await index.search('ab'), undefined, 'A short query is left to the history scan')
  assert.equal(await index.search('a b c'), undefined)
  assert.equal(snippet(`${'a'.repeat(500)} Ёлка ${'b'.repeat(500)}`, ['елка'], 10, 20), `…${'a'.repeat(9)} Ёлка ${'b'.repeat(15)}…`)
})

test('pages through ranked hits', async t => {
  const entries = Array.from({ length: 25 }, (_, i) => user(i + 1, `note ${i} about juniper`))
  const { index } = await fixture(t, entries)
  await index.catchUp()
  const first = await index.search('juniper', { limit: 10 })
  const second = await index.search('juniper', { limit: 10, offset: 10 })
  const third = await index.search('juniper', { limit: 10, offset: 20 })
  assert.equal(first.more, true)
  assert.equal(third.more, false)
  assert.deepEqual(new Set([...first.ids, ...second.ids, ...third.ids]).size, 25)
})

test('catches up after a crash, including an entry committed late with a lower ID', async t => {
  const { path, source, index } = await fixture(t, [user(1, 'alpha one'), user(3, 'gamma three')])
  await index.catchUp()
  await index.close()
  // The daemon stopped before indexing these; entry 2 committed after entry 3 had been indexed.
  source.entries.push(user(2, 'beta two'), user(4, 'delta four'))
  const reopened = await MegachatSearchIndex.open(path, source.read)
  t.after(() => reopened.close())
  assert.equal(await reopened.catchUp(), 2)
  assert.deepEqual(await ids(reopened, 'beta'), [2])
  assert.deepEqual(await ids(reopened, 'delta'), [4])
  assert.equal(await reopened.catchUp(), 0, 'A second catch-up indexes nothing again')
  await reopened.append(user(5, 'epsilon five'))
  assert.deepEqual(await ids(reopened, 'epsilon'), [5])
  assert.equal(await reopened.lastEntryId(), 5)
})

test('rebuilds on demand, after a version change and from a corrupt file', async t => {
  const { path, source, index } = await fixture(t, [user(1, 'alpha one'), user(2, 'beta two')])
  await index.catchUp()
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.equal(await index.rebuild(), 2)
  assert.deepEqual(await ids(index, 'beta'), [2])
  await index.close()

  const raw = new DatabaseSync(path)
  raw.exec('UPDATE meta SET version = 0')
  raw.close()
  const migrated = await MegachatSearchIndex.open(path, source.read)
  assert.deepEqual(await ids(migrated, 'beta'), [], 'An index of another version is dropped')
  await migrated.catchUp()
  assert.deepEqual(await ids(migrated, 'beta'), [2])
  await migrated.close()

  await rm(`${path}-wal`, { force: true })
  await rm(`${path}-shm`, { force: true })
  await writeFile(path, Buffer.alloc(8192, 7))
  const recovered = await MegachatSearchIndex.open(path, source.read)
  t.after(() => recovered.close())
  await recovered.catchUp()
  assert.deepEqual(await ids(recovered, 'alpha'), [1])
})

test('pages past the ranked window into older matches', async t => {
  const total = RANK_WINDOW + 5
  const { index } = await fixture(t, Array.from({ length: total }, (_, i) => user(i + 1, `entry ${i} juniper`)))
  await index.catchUp()
  const seen = new Set()
  let offset = 0
  let page
  do {
    page = await index.search('juniper', { limit: 500, offset })
    for (const id of page.ids) seen.add(id)
    offset += page.ids.length
  } while (page.more)
  assert.equal(seen.size, total)
  assert.ok((await index.search('juniper', { limit: 10 })).ids.every(id => id > 5), 'The first page ranks the newest window')
})

test('indexes child results and the project events of an old history without IDs', async t => {
  const children = { kind: 'air.megachat.event', id: 1, conversationId: 1, model: [{ role: 'user', content: 'event JSON', timestamp: 5000 }],
    data: { type: 'children', results: [
      { runId: 'run-7f3a9c', cwd: '/src/app/plugins/editor', prompt: 'Profile json-profiler', status: 'completed',
        output: `${'z'.repeat(3000)} lostmarker`, truncated: false, error: null },
      { runId: 'run-0b1d', cwd: '/src/release-16', prompt: 'Build', status: 'failed', output: '', error: 'Сборка упала' },
    ] } }
  const projectEvent = { kind: 'air.megachat.event', id: 2, conversationId: 1, model: [{ role: 'user', content: 'event JSON', timestamp: 6000 }],
    data: { type: 'project', cwd: '/src/megachat-workspace', revision: 'rev-55e1', paths: ['src/GothicIcon.kt'] } }
  const { index } = await fixture(t, [children, projectEvent])
  await index.catchUp()
  assert.deepEqual(await ids(index, 'json-profiler'), [1])
  assert.deepEqual(await ids(index, 'release-16 упала'), [1], 'The second result is indexed despite a long first output')
  assert.deepEqual(await ids(index, 'failed'), [1])
  assert.deepEqual(await ids(index, 'lostmarker'), [], 'Each result is truncated')
  assert.deepEqual(await ids(index, 'run-7f3a'), [], 'Run IDs are not indexed')
  assert.deepEqual(await ids(index, 'gothicicon'), [2])
  assert.deepEqual(await ids(index, 'megachat-workspace'), [2])
  assert.deepEqual(await ids(index, 'rev-55e1'), [])
  assert.deepEqual(await ids(index, 'event JSON'), [], 'The model copy of the event is not indexed')
  const indexed = entryText(projectEvent)
  assert.equal(indexed.role, 'event')
  assert.equal(indexed.timestamp, 6000)
  assert.ok(entryText(children, { full: true }).text.includes('lostmarker'), 'Snippets read the full result')
})
