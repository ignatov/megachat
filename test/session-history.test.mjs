import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SessionHistoryService } from '../src/SessionHistoryService.mjs'
import { CodexSessionHistoryService } from '../src/CodexSessionHistoryService.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { message } from '../src/messages.mjs'
import { KnownSecrets } from '../src/SessionText.mjs'

class HistoryFixture {
  constructor(cwd, sessionId, entries) { this.session = { cwd, sessionId, title: 'A project conversation' }; this.entries = entries }
  async list() { return { sessions: [this.session], nextCursor: null } }
  async read(cwd, id, cursor) {
    assert.equal(cwd, this.session.cwd)
    assert.equal(id, this.session.sessionId)
    const offset = Number(cursor ?? 0)
    return { session: this.session, entries: [this.entries[offset]], nextCursor: offset + 1 < this.entries.length ? String(offset + 1) : null }
  }
  close() {}
}

class PartlyUnavailableHistory {
  constructor(cwd) { this.cwd = cwd }
  async list() {
    return { sessions: ['unavailable', 'available'].map(sessionId => ({ cwd: this.cwd, sessionId, title: 'A conversation' })), nextCursor: null }
  }
  async read(cwd, sessionId) {
    if (sessionId === 'unavailable') throw new Error('The session was removed')
    return { session: { cwd, sessionId }, entries: [{ text: 'Juniper decision' }], nextCursor: null }
  }
  close() {}
}

async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'megachat-sessions-')))
  t.after(() => rm(cwd, { force: true, recursive: true }))
  const entries = Array.from({ length: 7 }, (_, index) => ({ id: String(index), role: index % 2 ? 'assistant' : 'user',
    text: index === 6 ? `${'x'.repeat(5000)}The old Juniper decision.` : 'A different topic.' }))
  const sources = { claude: new HistoryFixture(cwd, 'claude-session', entries), codex: new HistoryFixture(cwd, 'codex-session', entries) }
  const state = { snapshot: async () => ({ workspaces: [cwd] }) }
  const service = new SessionHistoryService(state, sources)
  t.after(() => service.close())
  return { cwd, service }
}

test('both providers search message content beyond an empty page', { timeout: 10000 }, async t => {
  const { cwd, service } = await fixture(t)
  const first = await service.search({ cwd, query: 'Juniper' })
  assert.deepEqual(first.pages.map(page => page.agent), ['claude', 'codex'])
  for (const page of first.pages) {
    assert.deepEqual(page.matches, [])
    assert.equal(page.complete, false)
    const next = await service.search({ cwd, agent: page.agent, query: 'Juniper', cursor: page.nextCursor })
    assert.equal(next.pages[0].matches.length, 1)
    assert.equal(next.pages[0].complete, true)
    assert.ok(next.pages[0].matches[0].text.includes('Juniper'))
    assert.equal(next.pages[0].matches[0].truncated, true)
    assert.ok(next.pages[0].matches[0].textOffset > 0)
  }
})

test('one unavailable session preserves other matches and marks the search incomplete', { timeout: 10000 }, async t => {
  const { cwd } = await fixture(t)
  const service = new SessionHistoryService({ snapshot: async () => ({ workspaces: [cwd] }) }, { claude: new PartlyUnavailableHistory(cwd) })
  t.after(() => service.close())
  const { pages: [page] } = await service.search({ cwd, query: 'Juniper' })
  assert.equal(page.matches[0].sessionId, 'available')
  assert.equal(page.unreadableSessions, 1)
  assert.equal(page.complete, false)
  assert.equal(page.nextCursor, null)
  assert.ok(page.error)
})

test('history cursors cannot cross projects, providers, queries or sessions', { timeout: 10000 }, async t => {
  const { cwd, service } = await fixture(t)
  const page = await service.read({ cwd, agent: 'claude', sessionId: 'claude-session' })
  await assert.rejects(service.read({ cwd, agent: 'codex', sessionId: 'codex-session', cursor: page.nextCursor }), { code: 'invalid' })
  await assert.rejects(service.read({ cwd, agent: 'claude', sessionId: 'claude-session', query: 'new', cursor: page.nextCursor }), { code: 'invalid' })
  const search = await service.search({ cwd, agent: 'claude', query: 'Juniper' })
  await assert.rejects(service.search({ cwd, agent: 'codex', query: 'Juniper', cursor: search.pages[0].nextCursor }), { code: 'invalid' })
  await assert.rejects(service.search({ cwd: tmpdir() }), { code: 'workspace' })
  await assert.rejects(service.read({ cwd, agent: 'claude', sessionId: '../outside' }), { code: 'invalid' })
})

test('tampered or unsigned search cursors are rejected', { timeout: 10000 }, async t => {
  const { cwd, service } = await fixture(t)
  const { pages: [page] } = await service.search({ cwd, agent: 'claude', query: 'Juniper' })
  const [payload] = page.nextCursor.split('.')
  const position = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  position.sessions = [{ sessionId: '../outside', title: 'x' }]
  const tampered = Buffer.from(JSON.stringify(position)).toString('base64url')
  await assert.rejects(service.search({ cwd, agent: 'claude', query: 'Juniper', cursor: tampered }), { code: 'invalid' })
  await assert.rejects(service.search({ cwd, agent: 'claude', query: 'Juniper', cursor: `${tampered}.${page.nextCursor.split('.')[1]}` }), { code: 'invalid' })
  for (const cursor of ['garbage', 'a.b', `${payload}.AAAA`, `${page.nextCursor}.x`])
    await assert.rejects(service.search({ cwd, agent: 'claude', query: 'Juniper', cursor }), { code: 'invalid' })
  await assert.rejects(service.read({ cwd, agent: 'claude', sessionId: 'claude-session', cursor: 'garbage' }), { code: 'invalid' })
})

test('the child MCP tools search and read both providers without mutation tools', { timeout: 10000 }, async t => {
  const { cwd, service } = await fixture(t)
  const server = new DaemonServer({ sessions: service })
  await server.listen()
  const config = server.historyConfiguration()
  const client = new Client({ name: 'child-test', version: '1' })
  t.after(async () => { await client.close(); await server.close() })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: Object.fromEntries(config.headers.map(header => [header.name, header.value])) },
  }))
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(tool => tool.name), ['history', 'sessions', 'session_history'])
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint))
  // The tool of the children has no order, so its text offers no read from the end and no read outside the listed directories.
  const child = tools.find(tool => tool.name === 'session_history')
  assert.deepEqual(Object.keys(child.inputSchema.properties).sort(), ['agent', 'cursor', 'cwd', 'query', 'sessionId'])
  assert.ok(!/order|newest|outside/i.test(child.description), child.description)
  const found = await client.callTool({ name: 'sessions', arguments: { cwd } })
  const pages = JSON.parse(found.content[0].text).pages
  assert.equal(pages.length, 2)
  const read = await client.callTool({ name: 'session_history', arguments: { cwd, agent: 'codex', sessionId: 'codex-session' } })
  assert.equal(JSON.parse(read.content[0].text).entries[0].text, 'A different topic.')
  const invalid = await client.callTool({ name: 'session_history', arguments: { cwd: tmpdir(), agent: 'codex', sessionId: 'codex-session' } })
  assert.equal(invalid.isError, true)
})

test('Codex history pages retain messages within a long turn and include archived sessions', { timeout: 10000 }, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'megachat-codex-history-')))
  const service = new CodexSessionHistoryService({ command: process.execPath,
    args: [fileURLToPath(new URL('./fake-codex-app-server.mjs', import.meta.url)), cwd] })
  t.after(async () => { await service.close(); await rm(cwd, { force: true, recursive: true }) })
  const first = await service.list(cwd, null)
  assert.equal(first.sessions[0].sessionId, 'active')
  const archived = await service.list(cwd, first.nextCursor)
  assert.equal(archived.sessions[0].sessionId, 'archived')
  assert.equal(archived.nextCursor, null)
  const page = await service.read(cwd, 'active', null)
  assert.equal(page.entries.length, 20)
  const rest = await service.read(cwd, 'active', page.nextCursor)
  assert.equal(rest.entries.length, 5)
  assert.equal(rest.entries[0].id, '20')
  assert.equal(rest.nextCursor, null)
  await assert.rejects(service.read(tmpdir(), 'active', null), { code: 'missing' })
  for (const cursor of ['{not json', '[]', 'null', '{"archived":"yes"}', '{"archived":false,"cursor":{}}'])
    await assert.rejects(service.list(cwd, cursor), { code: 'invalid' })
  for (const cursor of ['{not json', '{"cursor":null,"offset":-1}', '{"cursor":5,"offset":0}'])
    await assert.rejects(service.read(cwd, 'active', cursor), { code: 'invalid' })
})

test('a search and a read of a live provider remove the exact values that the daemon knows and the key after /wire/', { timeout: 10000 }, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'megachat-sessions-secrets-')))
  t.after(() => rm(cwd, { force: true, recursive: true }))
  // Invented values: a key without a known prefix, the base URL that holds it, and a key after /wire/ that the daemon
  // does not know.
  const key = 'Qm7Tz2Lw9Xc4Vb8Nk1Rj6Hs3Fd5Gp0Ya2Ue'
  const address = `http://127.0.0.1:41234/proxy/${key}`
  const secrets = new KnownSecrets()
  secrets.add(key, address)
  const source = new HistoryFixture(cwd, 'printed', [{ id: '1', role: 'assistant',
    text: `Juniper: the key is ${key}, the base is ${address}, and http://127.0.0.1:9/wire/Pk3Wq8Zr1Xn6Cm9Vt4Bs7Lh2Jd5Fg0Ka8Ty/v1 works.` }])
  source.session.title = `Check ${key}`
  // The index is off, so the live provider answers. Its secrets are the values of the daemon.
  const service = new SessionHistoryService({ snapshot: async () => ({ workspaces: [cwd] }) }, { claude: source }, { enabled: false, secrets })
  t.after(() => service.close())
  const marker = message('sessions.secret')
  const text = `Juniper: the key is ${marker}, the base is ${marker}, and http://127.0.0.1:9/wire/${marker}/v1 works.`
  const read = await service.read({ cwd, agent: 'claude', sessionId: 'printed' })
  assert.deepEqual([read.session.title, read.entries[0].text], [`Check ${marker}`, text])
  const [page] = (await service.search({ cwd, agent: 'claude', query: 'Juniper' })).pages
  assert.deepEqual([page.matches[0].title, page.matches[0].text], [`Check ${marker}`, text])
})
