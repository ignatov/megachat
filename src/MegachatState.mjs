import { createHash, randomUUID } from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineDoc } from '@earendil-works/pi-durable'
import { message, requireCondition } from './messages.mjs'

export const terminalStates = new Set(['completed', 'cancelled', 'interrupted', 'failed', 'resumed'])
export const maxAutomaticResumes = 2
const sentStates = new Set(['dispatched', 'running', 'approval'])
/**
 * The reasons of Pi Durable for a turn without an answer that can go away: an error of the model, and a stop of the
 * daemon while the model answered. A turn that fails for another reason fails the same way again.
 */
const repeatableReasons = new Set(['model_error', 'interrupted'])
export const MegachatDoc = defineDoc({
  kind: 'air.megachat', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ schema: 1, workspaces: [], inputs: {}, runs: {}, permissions: {}, serviceSessions: {}, current: null }),
  // Each commit stores the whole document. Near the high counts of `retain`, each commit is slow: the retention tests
  // need a timeout of 30 seconds.
  checkpointWhen: () => true,
})

/** The address of a delegated session: the key of `serviceSessions` in the state document. */
const serviceSessionKey = run => JSON.stringify([run.agent ?? 'claude', run.cwd, run.providerSessionId])
const isServiceSession = run => run.serviceSession !== false && !!run.providerSessionId

/**
 * Gives the addresses of the delegated sessions of the runs. A state document from before the `serviceSessions` map
 * has only its runs, so `initialize` fills the map with this function, and a client of an older daemon uses it.
 */
export function serviceSessionsOf(runs) {
  return Object.fromEntries(Object.values(runs).filter(isServiceSession).map(run => [serviceSessionKey(run),
    { agent: run.agent ?? 'claude', cwd: run.cwd, providerSessionId: run.providerSessionId, recordedAt: run.createdAt ?? 0 }]))
}

/**
 * Deletes the oldest of the eligible records until `keep` records stay, or no eligible record stays.
 * A record without its time is older than each record with it. Records with the same time keep their stored order.
 */
function dropOldest(records, keep, time, eligible = () => true) {
  const entries = Object.entries(records)
  const ids = entries.filter(([, record]) => eligible(record)).map(([id, record]) => ({ id, time: time(record) ?? 0 }))
    .sort((left, right) => left.time - right.time).slice(0, Math.max(0, entries.length - keep)).map(item => item.id)
  for (const id of ids) delete records[id]
  return ids
}

/**
 * Keeps the conversation alive for years without a lifetime count. Each admission calls this in its transaction, before
 * it adds a record. When a record set reaches its high count, the oldest settled records go until the low count stays.
 * A running input, an unfinished or unreported run and a pending permission always stay. A run also stays while an
 * unfinished continuation descends from it, or while the current input reports it.
 */
function retain(state) {
  if (Object.keys(state.inputs).length >= 1000) dropOldest(state.inputs, 500, input => input.admittedAt, input => input.status !== 'running')
  if (Object.keys(state.runs).length >= 64) {
    const named = new Set(state.current ? state.inputs[state.current.requestId]?.resultRunIds ?? [] : [])
    for (const run of Object.values(state.runs)) {
      if (terminalStates.has(run.status)) continue
      for (let id = run.resumeOf; id && !named.has(id); id = state.runs[id]?.resumeOf) named.add(id)
    }
    const dropped = new Set(dropOldest(state.runs, 48, run => run.finishedAt,
      run => terminalStates.has(run.status) && run.reported && !named.has(run.id)))
    for (const [id, permission] of Object.entries(state.permissions)) {
      if (dropped.has(permission.runId)) delete state.permissions[id]
    }
  }
  if (Object.keys(state.permissions).length >= 256) {
    dropOldest(state.permissions, 128, permission => permission.createdAt, permission => permission.status !== 'pending'
      && (!state.runs[permission.runId] || terminalStates.has(state.runs[permission.runId].status)))
  }
  if (Object.keys(state.initiative.decisions).length >= 2000) dropOldest(state.initiative.decisions, 1000, decision => decision.decidedAt)
  if (Object.keys(state.serviceSessions).length >= 5000) dropOldest(state.serviceSessions, 4000, session => session.recordedAt)
}

/** Keeps the address of a delegated session after a prune of its runs, so Air still hides that session. */
function recordServiceSession(state, run) {
  if (!isServiceSession(run)) return
  retain(state)
  state.serviceSessions[serviceSessionKey(run)] = {
    agent: run.agent ?? 'claude', cwd: run.cwd, providerSessionId: run.providerSessionId, recordedAt: Date.now(),
  }
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value, (_, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    }
    return item
  })).digest('hex')
}

const plain = value => JSON.parse(JSON.stringify(value))

/**
 * Replaces an interrupted run with a queued continuation in the same transaction, so a result report never sees both.
 * A prompt that may have reached the provider is never sent again as a new task: its session receives a continuation
 * prompt instead. The continuation keeps the first prompt as its `task`, and the dispatch quotes it, because the
 * provider can lose a prompt that it did not store.
 * A planned stop of the daemon is no failure of the run, so its continuation does not count as an attempt.
 */
function scheduleResume(state, run, previousStatus, delayMs) {
  const attempt = run.resumeAttempt ?? 0
  if (run.status !== 'interrupted' || run.cancelRequested || run.closed || run.autoResume === false || run.resumedBy
    || attempt >= maxAutomaticResumes) return
  const sent = run.dispatched || sentStates.has(previousStatus)
  if (sent && !run.providerSessionId) return
  const prompt = sent ? message('child.continue') : run.prompt
  const task = run.task ?? (sent ? run.prompt : undefined)
  retain(state)
  const now = Date.now()
  const next = {
    id: randomUUID(), childSessionId: run.childSessionId, mainRunId: run.mainRunId, agent: run.agent ?? 'claude',
    requestId: `resume:${run.id}`, digest: digest({ resumeOf: run.id, prompt }), prompt, cwd: run.cwd, status: 'admitted',
    providerSessionId: run.providerSessionId ?? null, serviceSession: run.serviceSession,
    generation: null, pid: null, output: '', truncated: false, updates: [], updateBytes: 0,
    cancelRequested: false, createdAt: now, closed: false,
    resumeOf: run.id, resumeAttempt: run.plannedStop ? attempt : attempt + 1, notBefore: now + delayMs * 4 ** attempt,
    ...(task === undefined ? {} : { task }),
  }
  state.runs[next.id] = next
  run.status = 'resumed'
  run.resumedBy = next.id
}

/** Owns the durable admission, child runs, and permission decisions of the shared conversation. */
export class MegachatState {
  constructor(harness, root, { resumeDelayMs = 5000, reportRetryDelayMs = 5000 } = {}) {
    this.harness = harness
    this.root = root
    this.resumeDelayMs = resumeDelayMs
    this.reportRetryDelayMs = reportRetryDelayMs
  }

  async initialize() {
    await this.change(state => {
      requireCondition(state.schema === 1, 'schema')
      state.initiative ??= { declines: 0, silenced: false, suggestion: null, decisions: {}, projects: {}, pending: {} }
      state.serviceSessions ??= serviceSessionsOf(state.runs)
    })
  }

  async change(operation) {
    return this.root.commit(async tx => operation(await tx.doc(MegachatDoc, this.root.id), tx), BACKGROUND_CONTEXT)
  }

  async snapshot() {
    return this.harness.snapshot(MegachatDoc, this.root.id, BACKGROUND_CONTEXT)
  }

  async watch() {
    return this.harness.watchDoc(MegachatDoc, this.root.id, BACKGROUND_CONTEXT)
  }

  async addWorkspace(cwd) {
    await this.change(state => {
      if (!state.workspaces.includes(cwd)) state.workspaces.push(cwd)
    })
  }

  async submit(requestId, text) {
    requireCondition(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 200)
    requireCondition(typeof text === 'string' && text.length > 0 && text.length <= 100000)
    const hash = digest(text)
    return this.change(async (state, tx) => {
      const old = Object.hasOwn(state.inputs, requestId) ? state.inputs[requestId] : null
      if (old) {
        requireCondition(old.digest === hash, 'conflict')
        return plain(old)
      }
      requireCondition(state.current === null, 'busy')
      retain(state)
      const mainRunId = randomUUID()
      // The root keeps each request ID forever. A dropped input must start a new turn, so each admission has its own ID.
      const submissionId = await this.root.submit(tx, { type: 'input', content: text, requestId: `input:${mainRunId}` })
      const input = { digest: hash, mainRunId, submissionId, status: 'running', admittedAt: Date.now() }
      state.inputs[requestId] = input
      state.current = { id: mainRunId, requestId, cancelling: false, kind: 'user' }
      return input
    })
  }

  async proposal(requestId, text) {
    requireCondition(typeof text === 'string' && text.trim().length > 0 && text.length <= 4000)
    return this.initiativeDecision(requestId, { text }, initiative => {
      const allowed = !initiative.silenced && initiative.declines < 3 && initiative.suggestion === null
      if (allowed) initiative.suggestion = text
      return { allowed, suggestion: allowed ? text : null, declines: initiative.declines, silenced: initiative.silenced }
    })
  }

  async feedback(requestId, decision) {
    requireCondition(['accepted', 'declined', 'silence', 'resume'].includes(decision))
    return this.initiativeDecision(requestId, { decision }, initiative => {
      if (decision === 'declined' && initiative.suggestion !== null) initiative.declines++
      if (decision === 'silence') {
        initiative.silenced = true
        initiative.pending = {}
      }
      if (decision === 'accepted' || decision === 'resume') {
        initiative.declines = 0
      }
      if (decision === 'resume') initiative.silenced = false
      initiative.suggestion = null
      return { allowed: !initiative.silenced && initiative.declines < 3, declines: initiative.declines, silenced: initiative.silenced }
    })
  }

  async initiativeDecision(requestId, args, apply) {
    return this.change(state => {
      const initiative = state.initiative
      const hash = digest(args)
      const previous = initiative.decisions[requestId]
      if (previous) {
        requireCondition(previous.digest === hash, 'conflict')
        return plain(previous.result)
      }
      retain(state)
      const result = apply(initiative)
      initiative.decisions[requestId] = { digest: hash, result, decidedAt: Date.now() }
      return plain(result)
    })
  }

  async projectChanged({ cwd, revision, paths }) {
    requireCondition(typeof revision === 'string' && revision.length > 0 && revision.length <= 200)
    requireCondition(Array.isArray(paths) && paths.length > 0 && paths.length <= 100
      && paths.every(path => typeof path === 'string' && path.length > 0 && path.length <= 4096))
    return this.change(state => {
      requireCondition(state.workspaces.includes(cwd), 'workspace')
      const initiative = state.initiative
      const previous = initiative.projects[cwd]
      if (previous?.revision === revision) return { accepted: false }
      const now = Date.now()
      const ownWork = Object.values(state.runs).some(run => run.cwd === cwd
        && (!terminalStates.has(run.status) || now - (run.finishedAt ?? 0) < 5000))
      const notify = !initiative.silenced && !ownWork && (!previous?.notifiedAt || now - previous.notifiedAt >= 60000)
      initiative.projects[cwd] = { revision, notifiedAt: notify ? now : previous?.notifiedAt ?? 0 }
      if (notify) initiative.pending[cwd] = { cwd, revision, paths }
      return { accepted: true, notify }
    })
  }

  async nextProjectEvent() {
    return this.change(async (state, tx) => {
      if (state.current || state.initiative.silenced) return null
      const event = Object.values(state.initiative.pending)[0]
      if (!event) return null
      retain(state)
      const requestId = `project:${digest(event)}`
      const mainRunId = randomUUID()
      const submissionId = await this.root.submit(tx, {
        type: 'input', requestId, content: `${message('event.project')}\n${JSON.stringify(event)}`,
        entry: { kind: 'air.megachat.event', data: { type: 'project', ...event } },
      })
      delete state.initiative.pending[event.cwd]
      state.initiative.declines = 0
      state.initiative.suggestion = null
      const input = { digest: digest(event), mainRunId, submissionId, status: 'running', admittedAt: Date.now() }
      state.inputs[requestId] = input
      state.current = { id: mainRunId, requestId, cancelling: false, kind: 'event' }
      return input
    })
  }

  async readRun(runId) {
    return this.change(state => {
      const run = state.runs[runId]
      requireCondition(run, 'missing')
      if (terminalStates.has(run.status)) run.reported = true
      return plain(run)
    })
  }

  async nextChildResults() {
    return this.change(async (state, tx) => {
      if (state.current) return null
      const now = Date.now()
      const runs = Object.values(state.runs).filter(run => terminalStates.has(run.status) && !run.reported
        && (run.reportAfter ?? 0) <= now)
      if (runs.length === 0) return null
      retain(state)
      const results = runs.map(run => ({ runId: run.id, cwd: run.cwd, prompt: run.prompt,
        status: run.status, output: run.output, truncated: run.truncated, error: run.error ?? null,
        ...(run.resumedBy ? { resumedBy: run.resumedBy } : {}), ...(run.resumeOf ? { resumeOf: run.resumeOf } : {}) }))
      const mainRunId = randomUUID()
      const requestId = `children:${mainRunId}`
      const submissionId = await this.root.submit(tx, {
        type: 'input', requestId,
        content: `${message('event.children')}\n${JSON.stringify(results)}`,
        entry: { kind: 'air.megachat.event', data: { type: 'children', results } },
      })
      for (const run of runs) run.reported = true
      const input = { digest: digest(results), mainRunId, submissionId, status: 'running', admittedAt: Date.now(),
        resultRunIds: runs.map(run => run.id) }
      state.inputs[requestId] = input
      state.current = { id: mainRunId, requestId, cancelling: false, kind: 'report' }
      return input
    })
  }

  /**
   * Ends the current turn. [reason] is the reason code of Pi Durable for a turn without an answer. A result report
   * that fails for a reason that can go away is sent once more, after a delay. A cancelled report is not: the user
   * stopped it, or `interruptAutomaticTurn` already asked for a new report.
   */
  async settleInput(mainRunId, status, reason) {
    await this.change(state => {
      if (state.current?.id !== mainRunId) return
      const input = state.inputs[state.current.requestId]
      if (state.current.cancelling) status = 'cancelled'
      input.status = status
      if (status === 'interrupted') {
        // The state keeps only the reason code. The detail of the reason can hold the text of a provider.
        if (typeof reason === 'string') input.reason = reason.slice(0, 64)
        if (reason === undefined || repeatableReasons.has(reason)) {
          for (const id of input.resultRunIds ?? []) {
            const run = state.runs[id]
            if (!run || run.reportRepeated) continue
            run.reported = false
            run.reportRepeated = true
            run.reportAfter = Date.now() + this.reportRetryDelayMs
          }
        }
      }
      state.current = null
    })
  }

  async interruptAutomaticTurn() {
    return this.change(state => {
      if (!state.current || state.current.kind === 'user') return false
      state.current.cancelling = true
      for (const id of state.inputs[state.current.requestId].resultRunIds ?? []) state.runs[id].reported = false
      return true
    })
  }

  async admitChild(requestId, args) {
    requireCondition(typeof args.prompt === 'string' && args.prompt.length > 0 && args.prompt.length <= 64000)
    requireCondition(args.title === undefined || typeof args.title === 'string' && args.title.trim().length > 0 && args.title.length <= 60)
    const hash = digest(args)
    return this.change(state => {
      const old = Object.values(state.runs).find(run => run.requestId === requestId)
      if (old) {
        requireCondition(old.digest === hash, 'conflict')
        return plain(old)
      }
      requireCondition(state.current && !state.current.cancelling, 'inactive')
      requireCondition(!['event', 'report'].includes(state.current.kind), 'proposalOnly')
      requireCondition(state.workspaces.includes(args.cwd), 'workspace')
      requireCondition(Object.values(state.runs).filter(run => run.mainRunId === state.current.id).length < 8, 'limit')
      requireCondition(Object.values(state.runs).filter(run => !terminalStates.has(run.status)).length < 8, 'limit')
      const previous = args.childSessionId && Object.values(state.runs).findLast(run => run.childSessionId === args.childSessionId)
      const agent = previous ? previous.agent ?? 'claude' : args.agent ?? 'claude'
      requireCondition(['claude', 'codex'].includes(agent))
      requireCondition(!args.agent || args.agent === agent, 'conflict')
      if (args.childSessionId) {
        requireCondition(previous && previous.cwd === args.cwd && !previous.closed, 'missing')
        requireCondition(terminalStates.has(previous.status), 'busy')
      }
      const providerSessionId = previous?.providerSessionId ?? args.providerSessionId ?? null
      if (providerSessionId) {
        requireCondition(typeof providerSessionId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(providerSessionId))
        requireCondition(!Object.values(state.runs).some(run => (run.agent ?? 'claude') === agent
          && run.providerSessionId === providerSessionId && !terminalStates.has(run.status)), 'busy')
      }
      retain(state)
      const run = {
        id: randomUUID(), childSessionId: args.childSessionId ?? randomUUID(), mainRunId: state.current.id, agent,
        requestId, digest: hash, prompt: args.prompt, cwd: args.cwd, status: 'admitted',
        ...(args.title === undefined ? {} : { title: args.title.trim() }),
        providerSessionId,
        serviceSession: previous?.serviceSession ?? !args.providerSessionId,
        generation: null, pid: null, output: '', truncated: false, updates: [], updateBytes: 0,
        cancelRequested: false, createdAt: Date.now(), closed: false,
      }
      state.runs[run.id] = run
      return plain(run)
    })
  }

  async transition(runId, expected, changes) {
    return this.change(state => {
      const run = state.runs[runId]
      requireCondition(run, 'missing')
      if (!expected.includes(run.status)) return false
      if (changes.status === 'dispatched' && run.cancelRequested) {
        run.status = 'cancelled'
        return false
      }
      const previousStatus = run.status
      Object.assign(run, changes)
      if (changes.providerSessionId) recordServiceSession(state, run)
      if (run.status === 'dispatched') run.dispatched = true
      if (terminalStates.has(run.status)) {
        run.finishedAt = Date.now()
        scheduleResume(state, run, previousStatus, this.resumeDelayMs)
        for (const permission of Object.values(state.permissions)) {
          if (permission.runId === runId && permission.status === 'pending') permission.status = 'stale'
        }
      }
      return true
    })
  }

  async appendUpdate(runId, generation, update) {
    await this.change(state => {
      const run = state.runs[runId]
      if (!run || run.generation !== generation || terminalStates.has(run.status)) return
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
        const remaining = Math.max(0, 64000 - run.output.length)
        run.output += update.content.text.slice(0, remaining)
        run.truncated ||= update.content.text.length > remaining
      }
      const bytes = Buffer.byteLength(JSON.stringify(update))
      if (run.updates.length < 500 && bytes <= 32000 && (run.updateBytes ?? 0) + bytes <= 64000) {
        run.updates.push(update)
        run.updateBytes = (run.updateBytes ?? 0) + bytes
      }
      else run.truncated = true
    })
  }

  async requestPermission(runId, generation, request) {
    return this.change(state => {
      const run = state.runs[runId]
      requireCondition(run && run.generation === generation && !run.cancelRequested && !terminalStates.has(run.status), 'stale')
      requireCondition(JSON.stringify(request).length <= 32000 && Array.isArray(request.options) && request.options.length > 0)
      requireCondition(Object.values(state.permissions).filter(value => value.runId === runId).length < 32, 'limit')
      retain(state)
      const id = randomUUID()
      state.permissions[id] = { id, runId, generation, request, status: 'pending', decision: null, createdAt: Date.now() }
      run.status = 'approval'
      return id
    })
  }

  async respondPermission(id, decision) {
    await this.change(state => {
      const permission = state.permissions[id]
      requireCondition(permission, 'missing')
      requireCondition(permission.request.options.some(option => option.optionId === decision), 'invalid')
      if (permission.status === 'answered') {
        requireCondition(permission.decision === decision, 'conflict')
        return
      }
      const run = state.runs[permission.runId]
      requireCondition(run?.generation === permission.generation && !run.cancelRequested && !terminalStates.has(run.status), 'stale')
      requireCondition(permission.status === 'pending', 'stale')
      permission.decision = decision
      permission.status = 'answered'
      run.status = 'running'
    })
  }

  async cancel(mainRunId, runId = null) {
    await this.change(state => {
      requireCondition(state.current?.id === mainRunId, 'inactive')
      if (runId === null) state.current.cancelling = true
      if (runId !== null) {
        requireCondition(state.current.kind === 'user', 'proposalOnly')
        requireCondition(state.runs[runId], 'missing')
        // A report can keep a run while `retain` drops its continuation. So the walk stops at a dropped run.
        while (state.runs[state.runs[runId].resumedBy]) runId = state.runs[runId].resumedBy
      }
      for (const run of Object.values(state.runs)) {
        if ((runId === null ? run.mainRunId === mainRunId : run.id === runId) && !terminalStates.has(run.status)) {
          run.cancelRequested = true
          if (run.status === 'admitted') run.status = 'cancelled'
        }
      }
    })
  }

  async closeChild(childSessionId) {
    await this.change(state => {
      const runs = Object.values(state.runs).filter(run => run.childSessionId === childSessionId)
      requireCondition(runs.length > 0, 'missing')
      requireCondition(runs.every(run => terminalStates.has(run.status)), 'busy')
      for (const run of runs) run.closed = true
    })
  }

  async recover() {
    await this.change(state => {
      for (const run of Object.values(state.runs)) {
        if (terminalStates.has(run.status) || run.status === 'admitted') continue
        const previousStatus = run.status
        run.status = run.cancelRequested ? 'cancelled' : 'interrupted'
        run.finishedAt = Date.now()
        if (run.status === 'interrupted') {
          run.error ??= message('error.interrupted')
          scheduleResume(state, run, previousStatus, this.resumeDelayMs)
        }
      }
      for (const permission of Object.values(state.permissions)) {
        if (permission.status === 'pending') permission.status = 'stale'
      }
    })
  }
}
