import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { agent, methods, ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

let cancel
let cancelled = false
let servers = []
agent({ name: 'fake-claude' })
  .onRequest(methods.agent.initialize, () => ({ protocolVersion: 1,
    agentCapabilities: { loadSession: true, mcpCapabilities: { http: process.env.FAKE_ACP_HTTP !== '0' } }, authMethods: [] }))
  .onRequest(methods.agent.session.new, async ctx => {
    servers = ctx.params.mcpServers
    await writeFile(join(process.cwd(), 'session-request.json'), JSON.stringify({
      operation: 'new', claudeOptions: !!ctx.params._meta?.claudeCode,
    }))
    await writeFile(join(process.cwd(), 'agent.pid'), String(process.pid))
    return { sessionId: 'fake-session' }
  })
  .onRequest(methods.agent.session.load, async ctx => {
    servers = ctx.params.mcpServers
    await writeFile(join(process.cwd(), 'session-request.json'), JSON.stringify({
      operation: 'load', sessionId: ctx.params.sessionId, claudeOptions: !!ctx.params._meta?.claudeCode,
    }))
    await ctx.client.notify(methods.client.session.update, {
      sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old replay' } },
    })
    return {}
  })
  .onNotification(methods.agent.session.cancel, () => { cancelled = true; cancel?.() })
  .onRequest(methods.agent.session.prompt, async ctx => {
    const text = ctx.params.prompt.at(-1).text
    await appendFile(join(process.cwd(), 'dispatches'), `${text}\n`)
    // Each prompt with all of its blocks, so a test can read the blocks that the daemon adds before the task.
    await appendFile(join(process.cwd(), 'prompts'), `${JSON.stringify(ctx.params.prompt.map(block => block.text))}\n`)
    if (text === 'crash') process.exit(1)
    if (text === 'wait') {
      if (!cancelled) await new Promise(resolve => { cancel = resolve })
      return { stopReason: 'cancelled' }
    }
    if (text === 'approval') {
      const answer = await ctx.client.request(methods.client.session.requestPermission, {
        sessionId: 'fake-session', toolCall: { toolCallId: 'write', title: 'Write a file' },
        options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Deny' }],
      })
      if (answer.outcome.outcome !== 'selected') return { stopReason: 'cancelled' }
    }
    if (text === 'approvals') {
      const answers = await Promise.all(['first', 'second'].map(name => ctx.client.request(methods.client.session.requestPermission, {
        sessionId: 'fake-session', toolCall: { toolCallId: name, title: `Write the ${name} file` },
        options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Deny' }],
      })))
      if (answers.some(answer => answer.outcome.outcome !== 'selected')) return { stopReason: 'cancelled' }
    }
    let previous = await readFile(join(process.cwd(), 'dispatches'), 'utf8')
    if (text.startsWith('history:')) {
      const server = servers.find(server => server.name === 'megachat')
      const history = new Client({ name: 'fake-child', version: '1' })
      try {
        await history.connect(new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) },
        }))
        const result = await history.callTool({ name: 'history', arguments: { query: text.slice('history:'.length) } })
        previous = result.content[0].text
      }
      finally { await history.close() }
    }
    await ctx.client.notify(methods.client.session.update, {
      sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: previous } },
    })
    return { stopReason: 'end_turn' }
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
