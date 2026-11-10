import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { waitForState } from './waitForState.mjs'
import { MegachatError, requireCondition } from './messages.mjs'
import { MegachatHistoryServer } from './MegachatHistoryServer.mjs'

export class DaemonServer {
  constructor(service, shutdown = () => {}, { build } = {}) {
    this.service = service
    this.shutdown = shutdown
    this.build = build
    this.token = randomBytes(32).toString('hex')
    this.historyToken = randomBytes(32).toString('hex')
    this.history = new MegachatHistoryServer(service)
    this.server = createServer((request, response) => {
      this.handle(request, response).catch(error => {
        if (response.headersSent) { response.destroy(); return }
        response.writeHead(error.code === 'unauthorized' ? 401 : error instanceof MegachatError ? 409 : 500)
        response.end(JSON.stringify({ error: error instanceof MegachatError ? error.code : 'internal' }))
      })
    })
    this.server.requestTimeout = 15000
    this.server.headersTimeout = 10000
    this.server.maxConnections = 32
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    return { version: 1, pid: process.pid, ...(this.build ? { build: this.build } : {}), port: this.server.address().port, token: this.token }
  }

  async body(request) {
    const chunks = []
    let length = 0
    for await (const chunk of request) {
      length += chunk.length
      requireCondition(length <= 128000)
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }

  historyConfiguration() {
    return { name: 'megachat', type: 'http', url: `http://127.0.0.1:${this.server.address().port}/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${this.historyToken}` }] }
  }

  async handle(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1')
    const supplied = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${url.pathname === '/mcp' ? this.historyToken : this.token}`)
    requireCondition(supplied.length === expected.length && timingSafeEqual(supplied, expected), 'unauthorized')
    if (url.pathname === '/mcp') {
      await this.history.handle(request, response, request.method === 'POST' ? await this.body(request) : undefined)
      return
    }
    const send = value => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(value))
    }
    if (request.method === 'GET') {
      switch (url.pathname) {
        case '/health': send({ version: 1, pid: process.pid, ...(this.build ? { build: this.build } : {}) }); return
        case '/state': send(await this.service.state.snapshot()); return
        case '/conversation': send(await this.service.view()); return
        case '/history': {
          const before = Number(url.searchParams.get('before'))
          const after = Number(url.searchParams.get('after') ?? 0)
          requireCondition(Number.isSafeInteger(before) && before > 0 && Number.isSafeInteger(after) && after >= 0)
          send(await this.service.root.entries({ order: 'ascending', minEntryId: after + 1, maxEntryId: before }, 100, undefined, BACKGROUND_CONTEXT))
          return
        }
        case '/events': await this.events(response); return
        case '/wait': {
          const submissionId = Number(url.searchParams.get('submission'))
          requireCondition(Number.isSafeInteger(submissionId) && submissionId > 0)
          const abort = new AbortController()
          response.once('close', () => abort.abort())
          response.setHeader('content-type', 'application/json')
          this.keepAlive(response, ' ')
          const value = await waitForState(this.service.state, state => {
            const input = Object.values(state.inputs).find(input => input.submissionId === submissionId)
            requireCondition(input, 'missing')
            return input.status !== 'running' ? input : undefined
          }, { signal: abort.signal, timeoutMs: null })
          response.end(JSON.stringify(value))
          return
        }
        default: throw new MegachatError('invalid')
      }
    }
    requireCondition(request.method === 'POST')
    const body = await this.body(request)
    switch (url.pathname) {
      case '/workspace': {
        requireCondition(typeof body.cwd === 'string')
        const cwd = await realpath(body.cwd)
        requireCondition((await stat(cwd)).isDirectory())
        await this.service.state.addWorkspace(cwd)
        send({ cwd })
        return
      }
      case '/input': send(await this.service.submit(body.requestId, body.text)); return
      case '/project-event': send(await this.service.state.projectChanged(body)); return
      case '/permission': await this.service.state.respondPermission(body.id, body.decision); send({ accepted: true }); return
      case '/cancel': await this.service.cancel(); send({ cancelled: true }); return
      case '/shutdown': send({ stopping: true }); setImmediate(this.shutdown); return
      default: throw new MegachatError('invalid')
    }
  }

  keepAlive(response, chunk) {
    const heartbeat = setInterval(() => {
      if (!response.destroyed && response.writableLength === 0) response.write(chunk)
    }, 15000)
    heartbeat.unref()
    response.once('close', () => clearInterval(heartbeat))
  }

  async events(response) {
    response.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
    this.keepAlive(response, '{"type":"heartbeat"}\n')
    const views = []
    const stop = () => Promise.allSettled(views.map(view => view.stop()))
    response.once('close', stop)
    try {
      const publish = async (type, value) => {
        if (response.destroyed) return
        await new Promise((resolve, reject) => {
          response.write(`${JSON.stringify({ type, value })}\n`, error => error ? reject(error) : resolve())
        })
      }
      const conversation = await this.service.root.watch(BACKGROUND_CONTEXT, { min: 100, max: 200 })
      views.push(conversation)
      await publish('conversation', conversation.value)
      conversation.start(async call => { if (call.kind === 'value') await publish('conversation', call.value) })
      const tasks = await this.service.state.watch()
      views.push(tasks)
      await publish('tasks', tasks.value)
      tasks.start(async call => { if (call.kind === 'value') await publish('tasks', call.value) })
      if (response.destroyed) await stop()
    }
    catch (error) {
      await stop()
      throw error
    }
  }

  async close() {
    this.server.closeAllConnections()
    await new Promise(resolve => this.server.close(resolve))
  }
}
