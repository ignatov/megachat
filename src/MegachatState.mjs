import { createHash, randomUUID } from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineDoc } from '@earendil-works/pi-durable'
import { message, requireCondition } from './messages.mjs'
import { rmdir } from 'node:fs/promises'
import { createProjectDirectory, discoverRepositories, isDirectoryOf, KNOWN_PROJECTS_LIMIT, listedDirectory, resolveRepository } from './ProjectDirectories.mjs'

export const terminalStates = new Set(['completed', 'cancelled', 'interrupted', 'failed', 'resumed'])
export const maxAutomaticResumes = 2
/** The limit of the messages that the user adds to one task, for its first run and each continuation together. */
export const maxSteers = 16
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
  if (Object.keys(state.projectCreations ?? {}).length >= 200) dropOldest(state.projectCreations, 100, creation => creation.createdAt)
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
 * A stop for a message of the user (`steerRestart`) is no failure either. Its continuation starts at once, also after
 * the last attempt, because the message must reach the child. The limit of the messages limits these continuations.
 */
function scheduleResume(state, run, previousStatus, delayMs) {
  const attempt = run.resumeAttempt ?? 0
  if (run.status !== 'interrupted' || run.cancelRequested || run.closed || run.autoResume === false || run.resumedBy
    || attempt >= maxAutomaticResumes && !run.steerRestart) return
  const sent = run.dispatched || sentStates.has(previousStatus)
  if (sent && !run.providerSessionId) return
  // A pi child only reads, so its text names no git status and no file that it created.
  const prompt = !sent ? run.prompt : message(`${run.steerRestart ? 'child.steer.restarted' : 'child.continue'}${run.agent === 'pi' ? '.pi' : ''}`)
  addContinuation(state, run, {
    prompt, task: run.task ?? (sent ? run.prompt : undefined), steered: run.steerRestart ? 'restarted' : null, sent,
    resumeAttempt: run.plannedStop || run.steerRestart ? attempt : attempt + 1,
    notBefore: Date.now() + (run.steerRestart ? 0 : delayMs * 4 ** attempt),
  })
}

/**
 * Continues a completed run whose turn did not handle each message of the user: a message that came after the end of
 * the turn, or a message that the agent took but did not answer (see `AcpRunService.execute`). The provider session
 * stored the turn, so the continuation starts at once in the same session, and it does not count as an attempt.
 */
function followSteers(state, run) {
  if (run.status !== 'completed' || run.cancelRequested || run.closed || run.resumedBy || !run.providerSessionId) return
  if (!run.steers?.some(item => item.delivery === 'pending')) return
  addContinuation(state, run, { prompt: message('child.steer.followUp'), task: run.task ?? run.prompt, steered: 'followUp',
    sent: true, resumeAttempt: run.resumeAttempt ?? 0, notBefore: Date.now() })
}

/**
 * Replaces [run] with a queued continuation. The continuation keeps the title of the task. It gets each message of the
 * user that the provider session may not have, and its dispatch quotes them. After a stop for a message, and after a follow-up for one ([steered]),
 * the main agent gets one report: the report of the last run, with the output of the earlier run before its own.
 */
function addContinuation(state, run, { prompt, task, steered, sent, resumeAttempt, notBefore }) {
  retain(state)
  const next = {
    id: randomUUID(), childSessionId: run.childSessionId, mainRunId: run.mainRunId, agent: run.agent ?? 'claude',
    requestId: `resume:${run.id}`, digest: digest({ resumeOf: run.id, prompt }), prompt, cwd: run.cwd, status: 'admitted',
    providerSessionId: run.providerSessionId ?? null, serviceSession: run.serviceSession,
    generation: null, pid: null, output: steered ? run.output : '', truncated: steered ? run.truncated : false,
    cancelRequested: false, createdAt: Date.now(), closed: false,
    resumeOf: run.id, resumeAttempt, notBefore,
    ...(task === undefined ? {} : { task }),
    ...(run.title === undefined ? {} : { title: run.title }),
    // The run service starts it before the older queued runs, because the user waits for the message.
    ...(steered ? { urgent: true } : {}),
  }
  const steers = carrySteers(run, next.id, sent, steered ?? 'restarted')
  if (steers.length) next.steers = steers
  state.runs[next.id] = next
  run.status = 'resumed'
  run.resumedBy = next.id
  if (steered) run.reported = true
}

/**
 * Moves the messages of the user that [run] did not handle to its continuation [nextId]. A completed run handled each
 * message that is not `pending`. Another run handled none for certain. A copy is a possible repeat when the agent can
 * have it already: the steering request went out, or the prompt that held the message went out.
 * The follow-up of a completed run delivers each message that it gets, so such a message gets [outcome], `followUp`,
 * also after the answer `injected` or after a stop request that came at the end of the turn. A message that a stop
 * takes keeps an earlier outcome.
 */
function carrySteers(run, nextId, sent, outcome) {
  const carried = []
  for (const item of run.steers ?? []) {
    if (item.carriedBy || run.status === 'completed' && item.delivery !== 'pending') continue
    const repeat = !!item.repeat || item.sentAt !== undefined || item.delivery === 'delivered' || item.delivery === 'fallback' && sent
    const way = run.status === 'completed' ? outcome : item.outcome ?? outcome
    carried.push({ ...item, delivery: 'fallback', outcome: way, repeat })
    Object.assign(item, { delivery: 'fallback', outcome: way, carriedBy: nextId })
  }
  return carried
}

/** Counts the messages of the user in the task of [run]: in the run, and in each earlier run that it continues. */
function steerCount(state, run) {
  const ids = new Set()
  for (let current = run; current; current = state.runs[current.resumeOf]) {
    for (const item of current.steers ?? []) ids.add(item.id)
  }
  return ids.size
}

/** Finds a message of the user by its ID. The first match is the record of the run that the tool call steered. */
export function findSteer(state, steerId) {
  for (const run of Object.values(state.runs)) {
    const item = run.steers?.find(value => value.id === steerId)
    if (item) return { run, item }
  }
  return null
}

/** Owns the durable admission, child runs, and permission decisions of the shared conversation. */
export class MegachatState {
  constructor(harness, root, { resumeDelayMs = 5000, reportRetryDelayMs = 5000, workspace, stateDirectory, home, projectRoots, suggestions = false } = {}) {
    // With suggestions, the prompt of an event turn lets the main agent offer a next step.
    this.eventSuffix = suggestions ? '.suggest' : ''
    this.workspace = workspace
    this.repositoryOptions = { stateDirectory, home, roots: projectRoots }
    this.home = home
    this.harness = harness
    this.root = root
    this.resumeDelayMs = resumeDelayMs
    this.reportRetryDelayMs = reportRetryDelayMs
    // The service replaces this with the settings `events.enabled` and `events.ignore`. It reads them at each call.
    this.projectFilter = () => ({ enabled: true, ignored: () => false })
  }

  async initialize() {
    await this.change(state => {
      requireCondition(state.schema === 1, 'schema')
      state.initiative ??= { declines: 0, silenced: false, suggestion: null, decisions: {}, projects: {}, pending: {} }
      state.serviceSessions ??= serviceSessionsOf(state.runs)
      state.projects ??= []
      state.projectCreations ??= {}
      // The task of an import pass ends with its daemon. A summary that waits for its event turn stays.
      state.sessionIndex = { task: null, summary: state.sessionIndex?.summary ?? null }
      // The workspace of Megachat follows the state directory of this start, so the state does not keep an old one.
      state.megachatWorkspace = this.workspace ?? null
      // A build from before the output limit of the tail kept each update of a run. Nothing read these updates, and
      // they were most of the document.
      for (const run of Object.values(state.runs)) {
        delete run.updates
        delete run.updateBytes
      }
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

  /** Gives the listed directory that [cwd] names: a project of an IDE, a known repository, or the workspace. */
  async directory(cwd) {
    const state = await this.snapshot()
    // A registered path stays as the client gave it, so a follow-up names the same directory as its first task.
    return isDirectoryOf(state, cwd) ? cwd : listedDirectory(state, cwd, this.home)
  }

  /**
   * Adds a repository that the user named to the known list. An automatic turn cannot add one. With [requestId], the
   * same transaction records the end of the creation of that request.
   */
  async addProject(path, requestId) {
    const cwd = await resolveRepository(path, this.repositoryOptions)
    return this.change(state => {
      requireCondition(!['event', 'report'].includes(state.current?.kind), 'proposalOnly')
      if (!state.projects.includes(cwd)) {
        requireCondition(state.projects.length < KNOWN_PROJECTS_LIMIT, 'limit')
        state.projects.push(cwd)
      }
      if (requestId) state.projectCreations[requestId] = { path, cwd, createdAt: state.projectCreations[requestId]?.createdAt ?? Date.now() }
      return { cwd }
    })
  }

  /** Finds the git repositories that the user can add to the known list. The listed directories are not in the result. */
  async discoverProjects() {
    const state = await this.snapshot()
    const listed = [...state.projects, ...state.workspaces, ...(state.megachatWorkspace ? [state.megachatWorkspace] : [])]
    return discoverRepositories({ home: this.home, roots: this.repositoryOptions.roots, listed })
  }

  /**
   * Makes the directory of a new project in [root], the setting `projects.newRoot`, and adds it to the known list. An
   * automatic turn cannot make one. When the list refuses the directory, the empty directory goes away again.
   * The tool call runs again after a restart that cut it off, so [requestId] keys the creation: the state records the
   * path before its `mkdir`, and the directory with the known list after it. A second call gives the recorded directory,
   * or it uses again the empty directory of the first call.
   */
  async createProject(requestId, name, root) {
    requireCondition(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 200)
    const state = await this.snapshot()
    requireCondition(!['event', 'report'].includes(state.current?.kind), 'proposalOnly')
    const record = state.projectCreations[requestId]
    if (record?.cwd) return { cwd: record.cwd }
    const path = await createProjectDirectory(root, name, this.repositoryOptions, { reserved: record?.path,
      reserve: path => this.change(state => {
        retain(state)
        state.projectCreations[requestId] = { path, createdAt: Date.now() }
      }) })
    try { return await this.addProject(path, requestId) }
    catch (error) {
      await rmdir(path).catch(() => {})
      await this.change(state => { delete state.projectCreations[requestId] }).catch(() => {})
      throw error
    }
  }

  /** Removes a repository from the known list. A project of an IDE stays in the list of the directories. */
  async removeProject(path) {
    requireCondition(typeof path === 'string' && path.length > 0 && path.length <= 4096, 'directory')
    const { projects } = await this.snapshot()
    const cwd = projects.includes(path) ? path : await resolveRepository(path, this.repositoryOptions).catch(() => path)
    return this.change(state => {
      const index = state.projects.indexOf(cwd)
      requireCondition(index >= 0, 'workspace')
      state.projects.splice(index, 1)
      return { cwd }
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

  /**
   * Records a change of a project. Without project events, or when each path matches a pattern of `events.ignore`, the
   * change is not recorded, so it cannot start a turn later.
   */
  async projectChanged({ cwd, revision, paths: changed }) {
    requireCondition(typeof revision === 'string' && revision.length > 0 && revision.length <= 200)
    requireCondition(Array.isArray(changed) && changed.length > 0 && changed.length <= 100
      && changed.every(path => typeof path === 'string' && path.length > 0 && path.length <= 4096))
    const filter = this.projectFilter()
    const paths = filter.enabled ? changed.filter(path => !filter.ignored(path)) : []
    if (!paths.length) return { accepted: false, ignored: true }
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
      // A user who turns the project events off does not want the waiting events later as a burst.
      if (!this.projectFilter().enabled) {
        state.initiative.pending = {}
        return null
      }
      const event = Object.values(state.initiative.pending)[0]
      if (!event) return null
      retain(state)
      const requestId = `project:${digest(event)}`
      const mainRunId = randomUUID()
      const submissionId = await this.root.submit(tx, {
        type: 'input', requestId, content: `${message(`event.project${this.eventSuffix}`)}\n${JSON.stringify(event)}`,
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

  /** Stores the progress of an import pass of the session index for the chat, or `null` at its end. */
  async sessionsTask(task) {
    await this.change(state => { state.sessionIndex.task = task })
  }

  /** Stores the summary of the first pass of the session index. The next event turn tells it to the user one time. */
  async sessionsIndexed(summary) {
    await this.change(state => { state.sessionIndex = { task: null, summary } })
  }

  /** Forgets the task and the summary of the session index after the user took the consent back. */
  async sessionsOff() {
    await this.change(state => { state.sessionIndex = { task: null, summary: null } })
  }

  /** Starts the event turn that tells the summary of the first pass of the session index. */
  async nextSessionsEvent() {
    return this.change(async (state, tx) => {
      const summary = state.sessionIndex?.summary
      if (state.current || !summary) return null
      retain(state)
      const requestId = `sessions:${digest(summary)}`
      const mainRunId = randomUUID()
      const submissionId = await this.root.submit(tx, {
        type: 'input', requestId, content: `${message(`event.sessions${this.eventSuffix}`)}\n${JSON.stringify(summary)}`,
        entry: { kind: 'air.megachat.event', data: { type: 'sessions', ...summary } },
      })
      state.sessionIndex.summary = null
      const input = { digest: digest(summary), mainRunId, submissionId, status: 'running', admittedAt: Date.now() }
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
      // A continuation reports the task of the user, not its own prompt: the report of a steered task is the only one.
      const results = runs.map(run => ({ runId: run.id, cwd: run.cwd, prompt: run.task ?? run.prompt,
        ...(run.title === undefined ? {} : { title: run.title }), status: run.status, output: run.output, truncated: run.truncated, error: run.error ?? null,
        ...(run.resumedBy ? { resumedBy: run.resumedBy } : {}), ...(run.resumeOf ? { resumeOf: run.resumeOf } : {}) }))
      const mainRunId = randomUUID()
      const requestId = `children:${mainRunId}`
      const submissionId = await this.root.submit(tx, {
        type: 'input', requestId,
        content: `${message(`event.children${this.eventSuffix}`)}\n${JSON.stringify(results)}`,
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

  /**
   * Admits a child run. A new task without a named agent gets [defaultAgent], the setting `children.agent`. The digest
   * holds only [args], so a repeated request still finds its run after a change of the setting.
   */
  async admitChild(requestId, args, { defaultAgent = 'claude' } = {}) {
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
      requireCondition(isDirectoryOf(state, args.cwd), 'workspace')
      requireCondition(Object.values(state.runs).filter(run => run.mainRunId === state.current.id).length < 8, 'limit')
      requireCondition(Object.values(state.runs).filter(run => !terminalStates.has(run.status)).length < 8, 'limit')
      const previous = args.childSessionId && Object.values(state.runs).findLast(run => run.childSessionId === args.childSessionId)
      // A run without the field is from before the choice of the agent, so it is a Claude run.
      const agent = previous ? previous.agent ?? 'claude' : args.agent ?? defaultAgent
      requireCondition(['claude', 'codex', 'pi'].includes(agent))
      requireCondition(!args.agent || args.agent === agent, 'conflict')
      // A pi child is a conversation of this daemon. A session of the pi command-line agent cannot continue as one.
      requireCondition(agent !== 'pi' || !args.providerSessionId)
      if (args.childSessionId) {
        requireCondition(previous && previous.cwd === args.cwd && !previous.closed, 'missing')
        requireCondition(terminalStates.has(previous.status), 'childBusy')
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
        // A pi child has no session file of Claude Code or Codex, so Air has no session of it to hide.
        serviceSession: agent === 'pi' ? false : previous?.serviceSession ?? !args.providerSessionId,
        generation: null, pid: null, output: '', truncated: false,
        cancelRequested: false, createdAt: Date.now(), closed: false,
      }
      state.runs[run.id] = run
      return plain(run)
    })
  }

  /**
   * Records a message of the user for the unfinished run of a child session, before a process sends it. A repeated
   * [requestId] gives the first record. Only a turn of the user can add a message, and only to a run in a listed
   * directory, as for `agents_send`. A run that did not send its prompt
   * yet gets the message in its prompt (`queued`). A sent run gets it through the run service (`pending`).
   * Each message has `delivery`: `pending` until the agent took it, `delivered` when the agent took it into its turn,
   * and `fallback` when the message goes in the prompt of a run. `outcome` tells the main agent how it went.
   */
  async steer(requestId, args) {
    requireCondition(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 200)
    requireCondition(typeof args.childSessionId === 'string' && args.childSessionId.length > 0 && args.childSessionId.length <= 200)
    requireCondition(typeof args.prompt === 'string' && args.prompt.trim().length > 0)
    requireCondition(args.prompt.length <= 64000, 'steerLength')
    requireCondition(['queue', 'interrupt'].includes(args.mode))
    const hash = digest(args)
    return this.change(state => {
      for (const run of Object.values(state.runs)) {
        const old = run.steers?.find(item => item.requestId === requestId)
        if (old) {
          requireCondition(old.digest === hash, 'conflict')
          return { ...plain(old), runId: run.id }
        }
      }
      requireCondition(state.current && !state.current.cancelling, 'inactive')
      requireCondition(!['event', 'report'].includes(state.current.kind), 'steerEvent')
      const run = Object.values(state.runs).findLast(run => run.childSessionId === args.childSessionId)
      requireCondition(run && !run.closed, 'missing')
      // The project rules stay for a child that works: its directory can leave the list after its start.
      requireCondition(isDirectoryOf(state, run.cwd), 'workspace')
      requireCondition(!terminalStates.has(run.status), 'childIdle')
      requireCondition(!run.cancelRequested, 'inactive')
      requireCondition(steerCount(state, run) < maxSteers, 'steerLimit')
      const queued = !sentStates.has(run.status)
      const item = { id: randomUUID(), requestId, digest: hash, text: args.prompt, mode: args.mode, createdAt: Date.now(),
        delivery: queued ? 'fallback' : 'pending', outcome: queued ? 'queued' : null }
      // The document gives a draft of each stored value. So the push goes to the stored array, not to a new one.
      run.steers ??= []
      run.steers.push(item)
      return { ...plain(item), runId: run.id }
    })
  }

  /** Changes a message of the user in a run of [generation]. A run of another process or a finished run stays. */
  async updateSteer(runId, generation, steerId, changes) {
    return this.change(state => {
      const run = state.runs[runId]
      const item = run?.steers?.find(value => value.id === steerId)
      if (!item || run.generation !== generation || terminalStates.has(run.status)) return false
      Object.assign(item, changes)
      return true
    })
  }

  /**
   * Marks a run of [generation] for a stop and a continuation that holds each message of the user that waits. The run
   * service then cancels the turn. A cancel of the user wins: that run gets no continuation.
   */
  async restartForSteer(runId, generation) {
    return this.change(state => {
      const run = state.runs[runId]
      if (!run || run.generation !== generation || run.cancelRequested || terminalStates.has(run.status)) return false
      run.steerRestart = true
      for (const item of run.steers ?? []) if (item.delivery === 'pending') item.outcome ??= 'restarted'
      return true
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
        followSteers(state, run)
        for (const permission of Object.values(state.permissions)) {
          if (permission.runId === runId && permission.status === 'pending') permission.status = 'stale'
        }
      }
      return true
    })
  }

  /**
   * Keeps the text that the agent wrote, at most the last 64,000 characters: the result of a long run is at its end.
   * Each other update changes no state, so it costs no commit of the document.
   */
  async appendUpdate(runId, generation, update) {
    if (update.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text') return
    await this.change(state => {
      const run = state.runs[runId]
      if (!run || run.generation !== generation || terminalStates.has(run.status)) return
      let output = run.output + update.content.text
      if (output.length > 64000) {
        run.truncated = true
        output = output.slice(-64000)
        // The cut must not leave the second half of a character at the start.
        if (/^[\uDC00-\uDFFF]/.test(output)) output = output.slice(1)
      }
      run.output = output
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
        // Pi Durable continues the conversation of a dispatched pi run after the restart, and the pi run service follows it.
        if (run.agent === 'pi' && run.status === 'dispatched') continue
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
