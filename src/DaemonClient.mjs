import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MegachatError, requireCondition } from './messages.mjs'

export class DaemonClient {
  static async connect(directory) {
    let text
    try { text = await readFile(join(directory, 'daemon', 'connection.json'), 'utf8') }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      // Daemons before the shared home published the descriptor in the state directory itself.
      text = await readFile(join(directory, 'connection.json'), 'utf8')
    }
    const descriptor = JSON.parse(text)
    requireCondition(descriptor.version === 1 && Number.isInteger(descriptor.port) && descriptor.port > 0 && descriptor.port <= 65535
      && typeof descriptor.token === 'string' && /^[a-f0-9]{64}$/.test(descriptor.token), 'schema')
    return new DaemonClient(descriptor)
  }

  constructor(descriptor) {
    this.descriptor = descriptor
  }

  async request(path, body, signal) {
    const response = await fetch(`http://127.0.0.1:${this.descriptor.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.descriptor.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal,
    })
    if (!response.ok) {
      const error = await response.json()
      throw new MegachatError(['busy', 'conflict', 'missing', 'stale', 'inactive', 'unauthorized', 'stopClosed'].includes(error.error)
        ? error.error : 'invalid')
    }
    return response
  }

  async json(path, body, signal = AbortSignal.timeout(15000)) {
    return (await this.request(path, body, signal)).json()
  }

  async watch(consumer, signal) {
    const response = await this.request('/events', undefined, signal)
    let buffer = ''
    const decoder = new TextDecoder()
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true })
      requireCondition(buffer.length <= 32 * 1024 * 1024, 'limit')
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const event = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        await consumer(event)
      }
    }
  }
}
