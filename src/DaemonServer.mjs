import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { waitForState } from './waitForState.mjs'
import { logEvent, logFailure, MegachatError, requireCondition } from './messages.mjs'
import { MegachatHistoryServer } from './MegachatHistoryServer.mjs'
import { ReplyStream, streamEnabled } from './ReplyStream.mjs'

export class DaemonServer {
  /** [onStreamSent] gets each stream event and the time when the daemon sends it. A test uses it. */
  constructor(service, shutdown = () => {}, { build, version, stream = streamEnabled(), streamIntervalMs, onStreamSent } = {}) {
    this.service = service
    this.shutdown = shutdown
    this.build = build
    this.version = version
    this.stream = stream
    this.streamIntervalMs = streamIntervalMs
    this.onStreamSent = onStreamSent
    this.token = randomBytes(32).toString('hex')
    this.historyToken = randomBytes(32).toString('hex')
    this.history = new MegachatHistoryServer(service)
    this.server = createServer((request, response) => {
      this.handle(request, response).catch(error => {
        // A refusal has a code for the client. Each other error is a fault of the daemon, and only the log shows it.
        if (!(error instanceof MegachatError)) logFailure('log.request', error, String(request.url).split('?')[0].slice(0, 40))
        if (response.headersSent) { response.destroy(); return }
        response.writeHead(error.code === 'unauthorized' ? 401 : error instanceof MegachatError ? 409 : 500)
        response.end(JSON.stringify({ error: error instanceof MegachatError ? error.code : 'internal' }))
      })
    })
    this.server.requestTimeout = 15000
    this.server.headersTimeout = 10000
    // Each view holds one `/events` stream, and one `/wait` while its prompt runs. One bridge has at most 32 views, and
    // each product window and each command connects too. At the limit, the server closes each new connection, so
    // `start` finds no daemon. So the real use must not reach the limit: 1,024 is 16 bridges with 32 busy views each.
    // The limit stays far below the file limit that Node.js sets for itself. The server listens on 127.0.0.1 only, and
    // it checks the token before it reads a body.
    this.server.maxConnections = 1024
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
      // An input has at most 100,000 characters, and one character can take 6 bytes in JSON.
      requireCondition(length <= 1000000)
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
        case '/health': send({ version: 1, pid: process.pid, ...(this.build ? { build: this.build } : {}), ...(this.version ? { megachatVersion: this.version } : {}) }); return
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
        // A directory that the daemon cannot read is a refusal for the client, not a fault of the daemon.
        const cwd = await realpath(body.cwd).catch(() => { throw new MegachatError('invalid') })
        requireCondition((await stat(cwd)).isDirectory())
        await this.service.state.addWorkspace(cwd)
        send({ cwd })
        return
      }
      case '/input': send(await this.service.submit(body.requestId, body.text)); return
      case '/prompt-suggestion/withdraw': {
        requireCondition(typeof body.id === 'string' && body.id.length <= 200)
        send({ withdrawn: await this.service.withdrawPromptSuggestion(body.id) })
        return
      }
      case '/permission': await this.service.state.respondPermission(body.id, body.decision); send({ accepted: true }); return
      case '/cancel': {
        // A client from before the turn ID sends no ID. Then the stop is for the current turn, as before.
        requireCondition(body.mainRunId === undefined || typeof body.mainRunId === 'string')
        send({ cancelled: await this.service.cancel(body.mainRunId) })
        return
      }
      case '/stop/answer': {
        // The answer of the user in the dialog of a stop request of the main agent. Only an answer here lets the tool send the signal.
        requireCondition(this.service.stopper && typeof body.id === 'string' && typeof body.optionId === 'string')
        send(this.service.stopper.answer(body.id, body.optionId))
        return
      }
      case '/child/stop': {
        // The Stop action of a row in the chat. It needs no turn, so it does not use `/cancel`.
        requireCondition(typeof body.runId === 'string' && body.runId.length <= 200)
        send({ stopped: await this.service.state.stopChild(body.runId) })
        return
      }
      case '/compact': {
        // A summary of a large conversation takes minutes, so the response stays open as `/wait` does.
        response.setHeader('content-type', 'application/json')
        this.keepAlive(response, ' ')
        response.end(JSON.stringify(await this.service.compact()))
        return
      }
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
      const tasks = await this.service.state.watch()
      views.push(tasks)
      await publish('tasks', tasks.value)
      const stream = this.stream ? new ReplyStream(publish, { intervalMs: this.streamIntervalMs, onFirstText: (reply, ms) => this.firstText(reply, ms),
        onSent: this.onStreamSent }) : undefined
      response.once('close', () => stream?.stop())
      // The partial reply changes the view many times in a second. Only a view with other entries is a new conversation.
      const mark = view => `${view.before ?? 0}:${view.entries.at(-1)?.id ?? 0}`
      let sent = mark(conversation.value)
      // A client that connects in the middle of a reply gets the text so far, after the conversation and the tasks.
      await stream?.observe(conversation.value)
      conversation.start(async call => {
        if (call.kind !== 'value') return
        const next = mark(call.value)
        if (next !== sent) { sent = next; await publish('conversation', call.value) }
        await stream?.observe(call.value)
      })
      tasks.start(async call => { if (call.kind === 'value') await publish('tasks', call.value) })
      // The stop requests of the main agent are in the memory of the daemon, not in the state. A client of an earlier
      // build ignores this event type.
      const stopper = this.service.stopper
      if (stopper) {
        const stops = async value => { await publish('stops', value); if (!response.destroyed) stopper.delivered(value) }
        const unwatch = stopper.watch(value => { stops(value).catch(() => {}) })
        views.push({ stop: async () => unwatch() })
        await stops(stopper.view())
      }
      if (response.destroyed) await stop()
    }
    catch (error) {
      await stop()
      throw error
    }
  }

  /** Writes the time to the first text of a model request to the log, one time for all the clients. */
  firstText(reply, ms) {
    const key = `${reply.taskId}:${reply.attempt}`
    if (this.loggedReply === key) return
    this.loggedReply = key
    logEvent('log.stream.first', Math.round(ms))
  }

  async close() {
    this.server.closeAllConnections()
    await new Promise(resolve => this.server.close(resolve))
  }
}
