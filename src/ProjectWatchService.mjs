import { randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { extname, isAbsolute, normalize, sep } from 'node:path'
import { message } from './messages.mjs'

const ignored = new Set(['.git', '.idea', '.gradle', '.venv', 'node_modules', 'out', 'dist', 'target', '__pycache__'])
const extensions = new Set(['.kt', '.kts', '.java', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.rb', '.php', '.html', '.css', '.scss', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml', '.xml', '.properties', '.md', '.sql', '.sh', '.bzl'])

/** Observes project paths without reading their contents or walking the directory tree. */
export class ProjectWatchService {
  constructor(state, { debounceMs = 2000 } = {}) {
    this.state = state
    this.debounceMs = debounceMs
    this.watchers = new Map()
    this.pending = new Set()
    this.closed = false
  }

  async start() {
    this.subscription = await this.state.watch()
    this.observe(this.subscription.value)
    this.subscription.start(call => { if (call.kind === 'value') this.observe(call.value) })
  }

  observe(snapshot) {
    if (this.closed) return
    for (const cwd of snapshot.workspaces) {
      if (this.watchers.has(cwd)) continue
      const entry = { watcher: null, timer: null, paths: new Set() }
      this.watchers.set(cwd, entry)
      try {
        entry.watcher = watch(cwd, { recursive: true, persistent: false }, (_event, file) => {
          const path = projectSourcePath(file)
          if (!path || this.closed) return
          // The settings of the project events apply to each file event. The state applies them again to the batch.
          const filter = this.state.projectFilter?.()
          if (filter && (!filter.enabled || filter.ignored(path))) return
          if (entry.paths.size < 100) entry.paths.add(path)
          entry.timer ??= setTimeout(() => this.flush(cwd, entry), this.debounceMs)
        })
        entry.watcher.on('error', () => process.stderr.write(`${message('error.watch', cwd)}\n`))
      }
      catch { process.stderr.write(`${message('error.watch', cwd)}\n`) }
    }
  }

  flush(cwd, entry) {
    entry.timer = null
    if (this.closed || entry.paths.size === 0) return
    const paths = [...entry.paths].sort()
    entry.paths.clear()
    const work = this.state.projectChanged({ cwd, revision: randomUUID(), paths })
      .catch(() => { if (!this.closed) process.stderr.write(`${message('error.event')}\n`) })
    this.pending.add(work)
    work.finally(() => this.pending.delete(work)).catch(() => {})
  }

  async close() {
    this.closed = true
    await this.subscription?.stop()
    for (const entry of this.watchers.values()) {
      clearTimeout(entry.timer)
      entry.watcher?.close()
    }
    this.watchers.clear()
    await Promise.allSettled([...this.pending])
  }
}

export function projectSourcePath(file) {
  if (typeof file !== 'string' || isAbsolute(file)) return null
  const path = normalize(file)
  const parts = path.split(sep)
  if (parts.some(part => part === '..' || ignored.has(part) || part.startsWith('bazel-'))) return null
  if (!extensions.has(extname(path).toLowerCase()) && !['Makefile', 'Dockerfile', 'BUILD', 'BUILD.bazel'].includes(parts.at(-1))) return null
  return parts.join('/')
}
