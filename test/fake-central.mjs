import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { AcpBridge } from '../src/AcpBridge.mjs'
import { CentralConfigurationService } from '../src/CentralConfigurationService.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'

/** The key of each fake Central configuration. The state and the log must not hold it. */
export const SECRET = 'sk-secret-value'

/** A free port on `127.0.0.1` that nothing listens on, as a Central whose local proxy is down. */
export async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

/** The output of `central run pi` for a local proxy at [port]. */
export const configurationOf = port => JSON.stringify({ anthropic: { baseUrl: `http://127.0.0.1:${port}/wire/${SECRET}`, apiKey: SECRET } })

/** A local proxy that answers each model request with the HTTP status [status] and an error of the Anthropic API. */
export async function statusProxy(t, status) {
  const server = createHttpServer(async (request, response) => {
    for await (const _ of request) { /* The body of the request. */ }
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'overloaded_error', message: 'The provider refused it.' } }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return server.address().port
}

/** A local proxy that accepts each connection and closes it after the first bytes of the request, before a response. */
export async function resetProxy(t) {
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('data', () => socket.destroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve) }))
  return server.address().port
}

/**
 * A Central command in a new temporary directory: a shell script with the lines [body]. The directory stays in the
 * temporary directory of the system.
 */
export async function centralCommand(body) {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-central-'))
  const central = join(directory, 'central')
  await writeFile(central, `#!/bin/sh\n${body}\n`)
  await chmod(central, 0o700)
  return { directory, central }
}

/**
 * A daemon whose main agent gets its configuration from the Central command [central], and one view of Air. `prompt`
 * sends a message and gives the stop reason and the text of the notice of the turn.
 */
export async function centralChat(t, central) {
  const cwd = await mkdtemp(join(tmpdir(), 'megachat-central-chat-'))
  const configuration = new CentralConfigurationService({ central })
  const service = await PiMegachatService.open(new MemoryStorage(), configuration.models(), { provider: 'anthropic', modelId: 'claude-opus-5-5' }, {},
    { keepAlive: { enabled: false }, secrets: configuration.secrets, centralFailure: () => configuration.lastFailure })
  await service.state.addWorkspace(cwd)
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  await service.resume()
  const updates = []
  const connection = client({ name: 'test-air' }).onNotification('*', ({ params }) => { updates.push(params) })
    .connect(new AcpBridge(daemon).app())
  t.after(async () => { await connection.close(); await server.close(); await service.close() })
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: { _meta: { jetbrains: { air: { version: 1, capabilities: [] } } } } })
  const { sessionId } = await connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
  const prompt = async text => {
    const start = updates.length
    const { stopReason } = await connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] })
    const notices = updates.slice(start).filter(event => event.update.messageId?.startsWith('megachat-notice-')).map(event => event.update.content.text)
    return { stopReason, notice: notices.join('') }
  }
  return { configuration, service, prompt }
}
