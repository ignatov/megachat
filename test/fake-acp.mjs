import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { agent, methods, ndJsonStream, RequestError } from '@agentclientprotocol/sdk/unstable'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

let cancel
let cancelled = false
let servers = []
// The prompt `steer` waits for a steering request or a cancel. FAKE_ACP_STEERING gives the answers to the steering
// requests in their order, separated by commas, and the last answer repeats: injected (the default), promptRequired,
// failed, error, drop (injected, and the turn ends with no work after it), trail (injected, with a chunk of the reply
// before the answer and one more chunk of the same reply after it, then the end of the turn), or hang (no answer). off is an agent
// without the steering extension.
const answers = (process.env.FAKE_ACP_STEERING ?? 'injected').split(',')
let steerings = 0
let prompting = false
let steered
let prompted = false
agent({ name: 'fake-claude' })
  .onRequest(methods.agent.initialize, () => ({ protocolVersion: 1,
    agentCapabilities: { loadSession: true, mcpCapabilities: { http: process.env.FAKE_ACP_HTTP !== '0' } }, authMethods: [],
    ...(answers[0] === 'off' ? {} : { _meta: { steering: { supported: true } } }) }))
  .onRequest('_session/steering', params => params, async ctx => {
    if (answers[0] === 'off') throw RequestError.methodNotFound('_session/steering')
    const answer = answers[Math.min(steerings++, answers.length - 1)]
    await appendFile(join(process.cwd(), 'steerings'), `${JSON.stringify(ctx.params)}\n`)
    if (answer === 'hang') return new Promise(() => {})
    if (answer === 'error') throw RequestError.internalError()
    if (answer === 'failed') return { outcome: 'failed' }
    const text = ctx.params.prompt.map(block => block.text).join('\n')
    // The turn ended before the request arrived.
    if (answer === 'promptRequired') { steered?.({ text, work: false }); return { outcome: 'promptRequired', reason: 'noRunningTurn' } }
    if (!prompting) return { outcome: 'promptRequired', reason: 'noRunningTurn' }
    // The reply of the step streams at the time of the request. The Codex adapter can send the rest after its answer.
    if (answer === 'trail') await ctx.client.notify(methods.client.session.update, {
      sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The reply ' } },
    })
    if (steered) setImmediate(steered, { text, work: answer !== 'drop' && answer !== 'trail', trail: answer === 'trail' })
    return { outcome: 'injected' }
  })
  .onRequest(methods.agent.session.new, async ctx => {
    // An agent without a login refuses each new session, as Codex ACP and Claude ACP do.
    if (process.env.FAKE_ACP_LOGIN === 'missing') throw RequestError.authRequired()
    servers = ctx.params.mcpServers
    await writeFile(join(process.cwd(), 'session-request.json'), JSON.stringify({
      operation: 'new', claudeOptions: !!ctx.params._meta?.claudeCode,
    }))
    // The options of a Claude session, so a test can read the settings sources and the session settings.
    if (ctx.params._meta?.claudeCode) await writeFile(join(process.cwd(), 'claude-options.json'), JSON.stringify(ctx.params._meta.claudeCode.options))
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
  // Each mode request, so a test can read the mode that the daemon sends. FAKE_ACP_MODES lists the modes of the
  // session, as the adapter lists the modes that the settings of Claude Code allow. The value exit ends the agent.
  .onRequest(methods.agent.session.setMode, async ctx => {
    await appendFile(join(process.cwd(), 'modes'), `${ctx.params.modeId} ${prompted ? 'after' : 'before'} the prompt\n`)
    // An agent that ends in the request, as after a crash.
    if (process.env.FAKE_ACP_MODES === 'exit') process.exit(1)
    if (!(process.env.FAKE_ACP_MODES ?? 'default,acceptEdits,plan,auto').split(',').includes(ctx.params.modeId))
      throw RequestError.invalidParams(undefined, `Mode ${ctx.params.modeId} is not available in this session`)
    return {}
  })
  // Each configuration request, so a test can read the model that the daemon sends. FAKE_ACP_MODELS lists the models
  // of the session, as the adapter lists the models that the settings of Claude Code allow.
  .onRequest(methods.agent.session.setConfigOption, async ctx => {
    await appendFile(join(process.cwd(), 'configs'), `${ctx.params.configId}=${ctx.params.value} ${prompted ? 'after' : 'before'} the prompt\n`)
    if (ctx.params.configId === 'model' && process.env.FAKE_ACP_MODELS && !process.env.FAKE_ACP_MODELS.split(',').includes(ctx.params.value))
      throw RequestError.invalidParams(undefined, `Invalid value for config option model: ${ctx.params.value}`)
    return { configOptions: [] }
  })
  .onNotification(methods.agent.session.cancel, () => { cancelled = true; cancel?.() })
  .onRequest(methods.agent.session.prompt, async ctx => {
    prompting = true
    prompted = true
    try { return await answerPrompt(ctx) }
    finally { prompting = false }
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))

async function answerPrompt(ctx) {
  const text = ctx.params.prompt.at(-1).text
  // The prompt `steer` takes a steering request from its arrival. A test sends the request when it reads `dispatches`,
  // so a request can arrive before the writes below end, and the turn must then keep the message.
  const steering = text === 'steer' && !cancelled ? new Promise(resolve => { steered = resolve; cancel = () => resolve(null) }) : undefined
  await appendFile(join(process.cwd(), 'dispatches'), `${text}\n`)
  // Each prompt with all of its blocks, so a test can read the blocks that the daemon adds before the task.
  await appendFile(join(process.cwd(), 'prompts'), `${JSON.stringify(ctx.params.prompt.map(block => block.text))}\n`)
  if (text === 'crash') process.exit(1)
  if (text === 'wait') {
    if (!cancelled) await new Promise(resolve => { cancel = resolve })
    return { stopReason: 'cancelled' }
  }
  if (text === 'steer') {
    const message = steering ? await steering : null
    steered = undefined
    if (!message) return { stopReason: cancelled ? 'cancelled' : 'end_turn' }
    if (message.trail) await ctx.client.notify(methods.client.session.update, {
      sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ends here.\n' } },
    })
    if (!message.work) return { stopReason: 'end_turn' }
    await ctx.client.notify(methods.client.session.update, {
      sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `steered: ${message.text}\n` } },
    })
    return { stopReason: 'end_turn' }
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
}
