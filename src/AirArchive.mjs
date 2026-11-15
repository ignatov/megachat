import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** The biggest `events.jsonl` that the check reads. A bigger file gives the state of the summary only. */
export const EVENTS_LIMIT = 64 * 1024 * 1024
const ARCHIVE_EVENTS = new Set(['ThreadArchived', 'ThreadUnarchived', 'ThreadArchiveStateChanged'])

const readJson = async path => { try { return JSON.parse(await readFile(path, 'utf8')) } catch { return undefined } }

/** The archive state that the last archive event of an `events.jsonl` gives, or undefined for a log without one. */
export function archiveEventState(text) {
  let state
  for (const line of text.split('\n')) {
    if (!line.includes('rchive')) continue
    let value
    try { value = JSON.parse(line) } catch { continue }
    if (!ARCHIVE_EVENTS.has(value?.type)) continue
    if (value.type === 'ThreadArchived') state = true
    else if (value.type === 'ThreadUnarchived') state = false
    else if (typeof value.payload?.archived === 'boolean') state = value.payload.archived
  }
  return state
}

/**
 * A read-only view of the store of Air for the archive state of its threads. Air keeps a store for each project at
 * `<caches>/<IDE>/acp/projects/<hash>/`, with `store.json` (the project directory) and `threads/<id>/summary.json` and
 * `events.jsonl`. Megachat never writes there: Air keeps the sequence counter and the projection of a thread in memory
 * (see "The archive of a session that has a thread of Air" in `docs/air-contract.md`).
 */
export class AirStore {
  /** [caches] is the directory `JetBrains` of the caches of the user. No directory means no Air. */
  constructor(caches) { this.caches = caches }

  /** The thread directories whose project is [cwd]: the hash can collide, so `store.json` decides. */
  async projects(cwd) {
    const found = []
    if (!this.caches || !cwd) return found
    for (const ide of await readdir(this.caches).catch(() => [])) {
      const root = join(this.caches, ide, 'acp', 'projects')
      for (const hash of await readdir(root).catch(() => [])) {
        if ((await readJson(join(root, hash, 'store.json')))?.projectDirectory === cwd) found.push(join(root, hash, 'threads'))
      }
    }
    return found
  }

  /** The thread of Air for an agent session: `{ directory, summary }`, or undefined. */
  async thread(agent, sessionId, cwd) {
    for (const threads of await this.projects(cwd)) {
      for (const name of await readdir(threads).catch(() => [])) {
        const directory = join(threads, name)
        let text
        try { text = await readFile(join(directory, 'summary.json'), 'utf8') } catch { continue }
        if (!text.includes(sessionId)) continue
        let summary
        try { summary = JSON.parse(text) } catch { continue }
        const association = summary?.association
        if (association?.agentSessionId === sessionId && (!association.namespaceId || association.namespaceId === agent)) return { directory, summary }
      }
    }
    return undefined
  }

  /**
   * What Air shows for a session, from one read: `{ air, hint }`. [logArchived] is the state that the log of the agent
   * gives, and it decides for a session without a thread. `air` is `hidden`, `still shown`, `no Air thread` or `unknown`.
   */
  async check(agent, sessionId, cwd, logArchived) {
    try {
      if (!this.caches) return { air: 'unknown', hint: 'hintUnknown' }
      const thread = await this.thread(agent, sessionId, cwd)
      if (!thread) return { air: 'no Air thread', hint: logArchived ? 'hintRefresh' : 'hintNone' }
      let archived = typeof thread.summary.archived === 'boolean' ? thread.summary.archived : undefined
      if (archived === undefined) {
        const events = join(thread.directory, 'events.jsonl')
        if ((await stat(events).catch(() => undefined))?.size <= EVENTS_LIMIT) archived = archiveEventState(await readFile(events, 'utf8').catch(() => ''))
      }
      if (archived === undefined) return logArchived ? { air: 'hidden', hint: 'hintLog' } : { air: 'still shown', hint: 'hintOwn' }
      return archived ? { air: 'hidden', hint: 'hintHidden' } : { air: 'still shown', hint: 'hintOwn' }
    }
    catch { return { air: 'unknown', hint: 'hintUnknown' } }
  }
}
