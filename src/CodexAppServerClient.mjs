import { spawn } from 'node:child_process'
import { megachatVersion } from './MegachatBuild.mjs'
import { MegachatError } from './messages.mjs'

/** Reads stored Codex sessions without resuming a thread or starting a model turn. */
export class CodexAppServerClient {
  static async open({ command = 'codex', args = ['app-server', '--listen', 'stdio://'], env = process.env } = {}) {
    const client = new CodexAppServerClient(spawn(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'] }))
    try {
      await client.request('initialize', { clientInfo: { name: 'air_megachat', title: 'Megachat', version: megachatVersion() } })
      client.child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
      return client
    }
    catch (error) { client.close(); throw error }
  }

  constructor(child) {
    this.child = child
    this.pending = new Map()
    this.nextId = 0
    this.closed = false
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 32 * 1024 * 1024) { this.close(); return }
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        let response
        try { response = JSON.parse(line) }
        catch { this.close(); return }
        if (response.method) {
          if (response.id !== undefined) this.child.stdin.write(`${JSON.stringify({ id: response.id,
            error: { code: -32601, message: 'Method not found' } })}\n`)
          continue
        }
        const pending = this.pending.get(response.id)
        if (!pending) continue
        this.pending.delete(response.id)
        clearTimeout(pending.timer)
        if (response.error) pending.reject(Object.assign(new MegachatError('sessions'), { rpcCode: response.error.code }))
        else pending.resolve(response.result)
      }
    })
    child.once('error', () => this.close())
    child.once('exit', () => this.close())
    child.stdin.on('error', () => this.close())
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new MegachatError('sessions'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), 15000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  close() {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new MegachatError('sessions'))
    }
    this.pending.clear()
    this.child.stdin.destroy()
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.kill('SIGTERM')
    setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
    }, 5000).unref()
  }
}
