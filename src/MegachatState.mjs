import { createHash, randomUUID } from 'node:crypto'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineDoc, InboxDoc, LiveDoc } from '@earendil-works/pi-durable'
import { message, requireCondition } from './messages.mjs'
import { endOf, logRunEnd, logRunStart } from './RunLog.mjs'
import { NOTE_KIND, noteMessage, pruneRecords } from './SessionNotes.mjs'
import { STOPPED_KIND } from './ReplyStream.mjs'
import { forgottenTopic } from './MegachatMemory.mjs'
import { REFLECTION_TURNS } from './MemoryReflection.mjs'
import { rmdir } from 'node:fs/promises'
import { createProjectDirectory, discoverRepositories, isDirectoryOf, KNOWN_PROJECTS_LIMIT, listedDirectory, resolveRepository } from './ProjectDirectories.mjs'
import { ChildTextFilter, redactOwnSecrets } from './SessionText.mjs'
import { PROMPT_SUGGESTION_LIFETIME_MS } from './Suggestions.mjs'
import { baseVersion, higherVersion, updateNoteText } from './MegachatUpdate.mjs'

export const terminalStates = new Set(['completed', 'cancelled', 'interrupted', 'failed', 'resumed'])

/**
 * Tells whether the user can answer [permission] in [state] now. The request must be pending, and its run must exist,
 * have the generation of the request, have no stop request, and not be in a terminal state. `respondPermission` takes a
 * new answer only then. For an answered request, it takes only a repeat of the same answer, which changes nothing.
 */
export function permissionOpen(state, permission) {
  const run = permission?.status === 'pending' ? state.runs[permission.runId] : undefined
  return !!run && run.generation === permission.generation && !run.cancelRequested && !terminalStates.has(run.status)
}
/**
 * The kinds of the automatic turns: a project event of an earlier build (`event`) and the summary of the past sessions,
 * a child result (`report`), and the morning report (`morning`). Such a turn starts no work and changes no setting.
 */
export const automaticKinds = new Set(['event', 'report', 'morning'])
/** The request IDs of the inputs of the automatic turns. Each other input is a turn of the user. */
export const automaticRequest = /^(children|sessions|morning):/

/**
 * The end of the last turn of the user in [state]: the time when the state settled its input, else its admission time,
 * which an input of an earlier build has alone. Gives `undefined` without a settled turn of the user.
 */
export function lastUserTurnEnd(state) {
  let last
  for (const [requestId, input] of Object.entries(state.inputs)) {
    if (automaticRequest.test(requestId) || input.status === 'running') continue
    const end = input.settledAt ?? input.admittedAt
    if (Number.isFinite(end) && !(end <= last)) last = end
  }
  return last
}
export const maxAutomaticResumes = 2
/** The limit of the messages that the user adds to one task, for its first run and each continuation together. */
export const maxSteers = 16
/** The limit of the child runs that one main task creates. */
export const maxChildRunsPerTask = 8
/** The limit of the unfinished child runs, queued runs included. */
export const maxUnfinishedRuns = 8
/** The limit of the permission requests of one child run. */
export const maxPermissionsPerRun = 32
const sentStates = new Set(['dispatched', 'running', 'approval'])
/**
 * The reasons of Pi Durable for a turn without an answer that can go away: an error of the model, and a stop of the
 * daemon while the model answered. A turn that fails for another reason fails the same way again.
 */
const repeatableReasons = new Set(['model_error', 'interrupted'])
/** The most lines of the notice of the reflection, also after more than one pass without a turn. */
const NOTICE_LINES = 16
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
  if (Object.keys(state.memoryWrites ?? {}).length >= 200) dropOldest(state.memoryWrites, 100, write => write.createdAt)
}

/** Keeps the address of a delegated session after a prune of its runs, so Air still hides that session. */
function recordServiceSession(state, run) {
  if (!isServiceSession(run)) return
  retain(state)
  state.serviceSessions[serviceSessionKey(run)] = {
    agent: run.agent ?? 'claude', cwd: run.cwd, providerSessionId: run.providerSessionId, recordedAt: Date.now(),
  }
}

/**
 * Removes the prompt suggestion of the `ghost` mode. The proposal of the gate goes with it, so the next turn can have a
 * suggestion again. The removal changes no counter.
 */
function clearPromptSuggestion(initiative) {
  if (!initiative.promptSuggestion) return
  initiative.promptSuggestion = null
  initiative.suggestion = null
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

/** Keeps at most the last 64,000 characters of the output of [run]: the result of a long run is at its end. */
function appendOutput(run, text) {
  if (!text) return
  let output = run.output + text
  if (output.length > 64000) {
    run.truncated = true
    output = output.slice(-64000)
    // The cut must not leave the second half of a character at the start.
    if (/^[\uDC00-\uDFFF]/.test(output)) output = output.slice(1)
  }
  run.output = output
}

/** Gives [value] with [change] applied to each text in it, also in the arrays and the objects in it. */
function eachText(value, change) {
  if (typeof value === 'string') return change(value)
  if (Array.isArray(value)) return value.map(item => eachText(item, change))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, eachText(item, change)]))
  return value
}

/**
 * Removes the copy of the output of the run before a pi continuation. Only a restart of the dispatched run reads it,
 * and the output of the run holds the same text.
 */
function dropCarriedOutput(run) {
  delete run.carriedOutput
  delete run.carriedTruncated
}

/**
 * Replaces an interrupted run with a queued continuation in the same transaction, so a result report never sees both.
 * A prompt that may have reached the provider is never sent again as a new task: its session receives a continuation
 * prompt instead. The continuation keeps the first prompt as its `task`, and the dispatch quotes it, because the
 * provider can lose a prompt that it did not store.
 * A planned stop of the daemon is no failure of the run, so its continuation does not count as an attempt.
 * A stop for a message of the user (`steerRestart`) is no failure either. Its continuation starts at once, also after
 * the last attempt, because the message must reach the child. The limit of the messages limits these continuations.
 */
function scheduleResume(state, run, previousStatus, delayMs, recovered = false) {
  const attempt = run.resumeAttempt ?? 0
  if (run.status !== 'interrupted' || run.cancelRequested || run.closed || run.autoResume === false || run.resumedBy
    || attempt >= maxAutomaticResumes && !run.steerRestart) return undefined
  const sent = run.dispatched || sentStates.has(previousStatus)
  if (sent && !run.providerSessionId) return undefined
  // A pi child only reads, so its text names no git status and no file that it created.
  const prompt = !sent ? run.prompt : message(`${run.steerRestart ? 'child.steer.restarted' : 'child.continue'}${run.agent === 'pi' ? '.pi' : ''}`)
  return addContinuation(state, run, {
    prompt, task: run.task ?? (sent ? run.prompt : undefined), steered: run.steerRestart ? 'restarted' : null, sent, recovered,
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
  if (run.status !== 'completed' || run.cancelRequested || run.closed || run.resumedBy || !run.providerSessionId) return undefined
  if (!run.steers?.some(item => item.delivery === 'pending')) return undefined
  return addContinuation(state, run, { prompt: message('child.steer.followUp'), task: run.task ?? run.prompt, steered: 'followUp',
    sent: true, resumeAttempt: run.resumeAttempt ?? 0, notBefore: Date.now() })
}

/**
 * Replaces [run] with a queued continuation. The continuation keeps the title of the task. It gets each message of the
 * user that the provider session may not have, and its dispatch quotes them. After a stop for a message, and after a follow-up for one ([steered]),
 * the main agent gets one report: the report of the last run, with the output of the earlier run before its own.
 */
function addContinuation(state, run, { prompt, task, steered, sent, resumeAttempt, notBefore, recovered = false }) {
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
  // The caller writes the log line after the commit, because a commit can run its function again.
  return { id: next.id, kind: steered === 'restarted' ? 'steer-restart' : steered === 'followUp' ? 'steer-followup' : recovered ? 'recovery' : 'continue',
    run: { id: next.id, resumeOf: run.id, childSessionId: next.childSessionId, providerSessionId: next.providerSessionId,
      agent: next.agent, cwd: next.cwd, title: next.title } }
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
  constructor(harness, root, { resumeDelayMs = 5000, reportRetryDelayMs = 5000, workspace, stateDirectory, home, projectRoots, suggestions = 'off',
    promptSuggestionLifetimeMs = PROMPT_SUGGESTION_LIFETIME_MS, secrets } = {}) {
    // The exact values of the own secret of Megachat (a `KnownSecrets`), such as the key of Central. Each text of a
    // child goes through `redactOwnSecrets` before the state keeps it.
    this.secrets = secrets
    // The filter of the text of each child run of this process, by run ID, with the generation of the run.
    this.childTexts = new Map()
    // The mode of the suggestions: `off`, `reply` or `ghost`. The service changes it when the setting changes.
    this.suggestionMode = suggestions
    // With suggestions, the prompt of an event turn lets the main agent offer a next step.
    this.eventSuffix = suggestions === 'off' ? '' : '.suggest'
    this.promptSuggestionLifetimeMs = promptSuggestionLifetimeMs
    this.workspace = workspace
    this.repositoryOptions = { stateDirectory, home, roots: projectRoots }
    this.home = home
    this.harness = harness
    this.root = root
    this.resumeDelayMs = resumeDelayMs
    this.reportRetryDelayMs = reportRetryDelayMs
  }

  async initialize() {
    // The first pass of the reflection after the upgrade does not read the conversation of an earlier build.
    const newest = (await this.snapshot())?.memoryReflection ? undefined : await this.newestEntryId()
    await this.change(state => {
      requireCondition(state.schema === 1, 'schema')
      state.initiative ??= { declines: 0, silenced: false, suggestion: null, decisions: {} }
      // The prompt suggestion of the `ghost` mode. A state of an earlier build has none.
      state.initiative.promptSuggestion ??= null
      // The offers of a setting by the key of the setting. A state of an earlier build has none.
      state.initiative.offers ??= {}
      // Megachat up to v0.3.0 watched the files of each project. `pending` kept each change that waited for its event
      // turn. This build has no such turn, so it drops these changes, and they start no turn. The two fields stay as
      // empty objects, because a daemon of v0.3.0 can open this state again, and it reads them.
      Object.assign(state.initiative, { projects: {}, pending: {} })
      state.serviceSessions ??= serviceSessionsOf(state.runs)
      state.projects ??= []
      state.projectCreations ??= {}
      // The outcomes of the writes of the tool agents_memory by the request ID. A state of an earlier build has none.
      state.memoryWrites ??= {}
      // The reflection of the memory: its position, the count of the completed turns of the user since the last pass,
      // whether a pass is due, the notice for the next turn, and the answer of a pass that did not finish its writes.
      state.memoryReflection ??= { throughEntryId: newest ?? 0, userTurns: 0, due: false, notice: null, pass: null }
      // The task of an import pass ends with its daemon. A summary that waits for its event turn stays, and so does the
      // summary of the turn that runs, which can wait for its repeat. A state of an earlier build has neither field.
      state.sessionIndex = { task: null, summary: state.sessionIndex?.summary ?? null, repeated: state.sessionIndex?.repeated ?? false,
        running: state.sessionIndex?.running ?? null }
      // The morning report: the local date of the last report, the data of a report that waits for its turn, and the
      // report of the turn that runs. A state of an earlier build has none.
      state.morningReport ??= { lastDate: null, pending: null, running: null }
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

  /** The ID of the newest entry of the retained conversation, or 0. */
  async newestEntryId() {
    return (await this.root.entries({ order: 'descending' }, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id ?? 0
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
      requireCondition(!automaticKinds.has(state.current?.kind), 'proposalOnly')
      if (!state.projects.includes(cwd)) {
        requireCondition(state.projects.length < KNOWN_PROJECTS_LIMIT, 'projectLimit', KNOWN_PROJECTS_LIMIT)
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
    requireCondition(!automaticKinds.has(state.current?.kind), 'proposalOnly')
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

  /**
   * Records the outcome of a write of the tool `agents_memory` before the rename of the file: the SHA-256 [before] of the
   * file before the write (`null` for no file), the SHA-256 [digest] of the new file, the [result] of the call, and
   * whether it is a [forget]. A call that runs again after a restart gives the result when the file has [digest], and
   * applies its action again only when the file has [before]. A call that runs again without its record applies its
   * action again, and the checks refuse a second copy of an entry.
   */
  async memoryWritten(requestId, { before, digest, result, forget = false }) {
    requireCondition(typeof requestId === 'string' && requestId.length > 0 && requestId.length <= 200)
    await this.change(state => {
      state.memoryWrites ??= {}
      retain(state)
      state.memoryWrites[requestId] = { before, digest, result, forget, createdAt: Date.now() }
    })
  }

  /**
   * Removes each record of `memoryWrites` but the record of the forget [requestId], after the rename of the forget. The
   * result of an earlier write can hold the text of the forgotten entry.
   *
   * The reflection does not learn the fact again: its position moves to the newest entry, so no later pass reads the
   * conversation before the forget, and the count of the turns starts again. A stored answer of a pass loses its adds
   * that are not written and its proposals. The notice and the lines of the stored answer lose each line that holds the
   * text [removed] of the removed entry or that the topic rule of [topic] matches. The other lines stay, so the user still
   * hears of each other add. Without the text of the removed entry ([removed] `undefined`), each line goes.
   */
  async memoryForgotten(requestId, { topic, removed = undefined } = {}) {
    const newest = await this.newestEntryId()
    const kept = line => typeof line === 'string' && removed !== undefined && !(removed && line.includes(removed))
      && !(topic && forgottenTopic(line, [topic]))
    await this.change(state => {
      const own = state.memoryWrites?.[requestId]
      state.memoryWrites = own ? { [requestId]: own } : {}
      const reflection = state.memoryReflection
      if (!reflection) return
      Object.assign(reflection, { throughEntryId: Math.max(reflection.throughEntryId, newest), userTurns: 0, due: false })
      const lines = reflection.notice?.lines.filter(kept) ?? []
      reflection.notice = lines.length ? { ...reflection.notice, lines } : null
      const pass = reflection.pass
      if (pass) Object.assign(pass, { adds: pass.adds.slice(0, pass.lines.length), proposals: [], userTurns: 0,
        lines: pass.lines.map(line => kept(line) ? line : null) })
    })
  }

  /** A summary completed, so a pass of the reflection is due. */
  async reflectionDue() {
    await this.change(state => { if (state.memoryReflection) state.memoryReflection.due = true })
  }

  /**
   * Stores the answer of a pass before its first write: `{ id, throughEntryId, userTurns, adds, proposals, lines }`.
   * `lines` gets the line of each add, or `null` for a refused add, in the order of `adds`. The pass read the
   * conversation after the position [from]. When the position moved during the request, after a forget, the answer is
   * not stored. Gives whether it is stored.
   */
  async reflectionAnswered(pass, from) {
    return this.change(state => {
      if (state.memoryReflection.throughEntryId !== from) return false
      state.memoryReflection.pass = pass
      return true
    })
  }

  /** Records the outcome of the add [index] of the pass [id]: its [line], or `null` for a refused add. */
  async reflectionAdded(id, index, line) {
    await this.change(state => {
      const pass = state.memoryReflection.pass
      if (pass?.id === id && pass.lines.length === index && index < pass.adds.length) pass.lines.push(line)
    })
  }

  /**
   * Ends the pass [id]: the position moves to the [throughEntryId] of the stored answer, the count loses the [userTurns]
   * that the pass read, and the notice for the next turn gets the lines of the adds and the proposals. [id] `null` ends a
   * pass that needed no request, with the [throughEntryId] and the [userTurns] of the call. Gives the lines of the adds
   * and the count of the proposals.
   */
  async reflectionDone({ id, throughEntryId, userTurns }) {
    return this.change(state => {
      const reflection = state.memoryReflection
      const pass = id === null ? { throughEntryId, userTurns, lines: [], proposals: [] } : reflection.pass
      if (id !== null && pass?.id !== id) return { lines: [], proposals: 0 }
      const lines = pass.lines.filter(line => typeof line === 'string')
      const shown = [...lines, ...pass.proposals.map(proposal => message('memory.reflection.proposal', proposal))]
      reflection.throughEntryId = Math.max(reflection.throughEntryId, pass.throughEntryId)
      reflection.userTurns = Math.max(0, reflection.userTurns - pass.userTurns)
      reflection.due = reflection.userTurns >= REFLECTION_TURNS
      reflection.pass = null
      if (shown.length) reflection.notice = { id: randomUUID(), lines: [...(reflection.notice?.lines ?? []), ...shown].slice(-NOTICE_LINES) }
      return { lines, proposals: pass.proposals.length }
    })
  }

  /** A pass failed: the next pass waits for 10 more completed turns of the user, or for a summary. */
  async reflectionFailed() {
    await this.change(state => Object.assign(state.memoryReflection, { userTurns: 0, due: false, pass: null }))
  }

  /** The setting `memory.reflection` is off: the position moves to [throughEntryId] without a pass. */
  async reflectionSkipped(throughEntryId) {
    await this.change(state => {
      const reflection = state.memoryReflection
      Object.assign(reflection, { throughEntryId: Math.max(reflection.throughEntryId, throughEntryId), userTurns: 0, due: false, pass: null })
    })
  }

  /**
   * A completed turn showed the [lines] of the notice, so they go away. A pass that ended during the turn added its lines
   * after them, and these lines stay for the next turn.
   */
  async reflectionNoticeShown(lines) {
    await this.change(state => {
      const notice = state.memoryReflection?.notice
      if (!notice) return
      const shown = [...lines]
      const rest = notice.lines.filter(line => {
        const index = shown.indexOf(line)
        if (index < 0) return true
        shown.splice(index, 1)
        return false
      })
      state.memoryReflection.notice = rest.length ? { ...notice, lines: rest } : null
    })
  }

  /**
   * Removes a repository from the known list. A project of an IDE stays in the list of the directories. The morning
   * report cannot remove one.
   */
  async removeProject(path) {
    requireCondition(typeof path === 'string' && path.length > 0 && path.length <= 4096, 'directory')
    const { projects } = await this.snapshot()
    const cwd = projects.includes(path) ? path : await resolveRepository(path, this.repositoryOptions).catch(() => path)
    return this.change(state => {
      requireCondition(state.current?.kind !== 'morning', 'morningReport')
      const index = state.projects.indexOf(cwd)
      requireCondition(index >= 0, 'workspace')
      state.projects.splice(index, 1)
      return { cwd }
    })
  }

  /**
   * Admits a prompt of the user. A live prompt suggestion ends with the start of the turn, and the prompt records
   * `ignored`, which changes no counter. The client does not tell whether the user took the text of the suggestion.
   */
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
      this.endPromptSuggestion(state, requestId)
      const mainRunId = randomUUID()
      // The root keeps each request ID forever. A dropped input must start a new turn, so each admission has its own ID.
      const submissionId = await this.root.submit(tx, { type: 'input', content: text, requestId: `input:${mainRunId}` })
      const input = { digest: hash, mainRunId, submissionId, status: 'running', admittedAt: Date.now() }
      state.inputs[requestId] = input
      state.current = { id: mainRunId, requestId, cancelling: false, kind: 'user' }
      return input
    })
  }

  /**
   * Records the decision on a prompt suggestion at the start of the turn of a user prompt, in the transaction of the
   * admission. A suggestion after its `expiresAt` goes without a record.
   */
  endPromptSuggestion(state, requestId) {
    const initiative = state.initiative
    const live = initiative.promptSuggestion
    if (!live) return
    if (Date.parse(live.expiresAt) > Date.now()) {
      const result = { decision: 'ignored', suggestionId: live.id, declines: initiative.declines, silenced: initiative.silenced }
      initiative.decisions[`input:${requestId}`] = { digest: digest({ decision: result.decision, suggestionId: live.id }), result, decidedAt: Date.now() }
    }
    clearPromptSuggestion(initiative)
  }

  /**
   * Records a proposal of the main agent. The gate allows it when the user did not ask for silence, after fewer than
   * three declines, and while no other proposal is live.
   * In the `ghost` mode the text becomes the prompt suggestion of the current turn, on one line. The gate then reads
   * only the prompt suggestion, so a proposal of the `reply` mode that waits for its feedback does not stop it. A turn
   * that admitted a child task is a delegation acknowledgment, and it gets no suggestion.
   */
  async proposal(requestId, text) {
    requireCondition(typeof text === 'string' && text.trim().length > 0 && text.length <= 4000)
    const ghost = this.suggestionMode === 'ghost'
    const shown = ghost ? text.replace(/\s+/g, ' ').trim() : text
    return this.initiativeDecision(requestId, { text }, (initiative, state) => {
      const free = ghost ? initiative.promptSuggestion === null && state.current !== null
        && !Object.values(state.runs).some(run => run.mainRunId === state.current.id) : initiative.suggestion === null
      const allowed = !initiative.silenced && initiative.declines < 3 && free
      if (allowed) initiative.suggestion = shown
      if (allowed && ghost) {
        initiative.promptSuggestion = { id: `suggestion-${randomUUID()}`, turnId: state.current.requestId, text: shown,
          expiresAt: new Date(Date.now() + this.promptSuggestionLifetimeMs).toISOString() }
      }
      return { allowed, suggestion: allowed ? shown : null, declines: initiative.declines, silenced: initiative.silenced }
    })
  }

  /**
   * Records the offer of the setting [key]. [open] tells whether the service allows an offer of the key: the mode, the
   * status of the setup, the list of the offers, and no stored value and no variable. The gate also refuses a key with an
   * offer before, a request for silence, and a second offer in the same turn. The offers are apart from `decisions`, so
   * the cut of the old decisions keeps them.
   */
  async offerSetting(requestId, key, open) {
    return this.initiativeDecision(requestId, { offer: key }, (initiative, state) => {
      const turnId = state.current?.requestId ?? null
      const allowed = open && !initiative.silenced && !Object.hasOwn(initiative.offers, key)
        && !(turnId !== null && Object.values(initiative.offers).some(offer => offer.turnId === turnId))
      if (allowed) initiative.offers[key] = { offeredAt: new Date().toISOString(), turnId }
      return { allowed }
    })
  }

  /** Withdraws the prompt suggestion [id] at its `expiresAt` or at a cancel of the user. Tells whether it was live. */
  async withdrawPromptSuggestion(id) {
    return this.change(state => {
      if (!id || state.initiative.promptSuggestion?.id !== id) return false
      clearPromptSuggestion(state.initiative)
      return true
    })
  }

  async feedback(requestId, decision) {
    requireCondition(['accepted', 'declined', 'silence', 'resume'].includes(decision))
    return this.initiativeDecision(requestId, { decision }, initiative => {
      if (decision === 'declined' && initiative.suggestion !== null) initiative.declines++
      if (decision === 'silence') initiative.silenced = true
      if (decision === 'accepted' || decision === 'resume') {
        initiative.declines = 0
      }
      if (decision === 'resume') initiative.silenced = false
      initiative.suggestion = null
      initiative.promptSuggestion = null
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
      const result = apply(initiative, state)
      initiative.decisions[requestId] = { digest: hash, result, decidedAt: Date.now() }
      return plain(result)
    })
  }

  /** Stores the progress of an import pass of the session index for the chat, or `null` at its end. */
  async sessionsTask(task) {
    await this.change(state => { state.sessionIndex.task = task })
  }

  /**
   * Stores the summary of the first pass of the session index. The next event turn tells it to the user one time. A
   * turn that a user message interrupted, or that failed for a reason that can go away, runs again one time.
   */
  async sessionsIndexed(summary) {
    await this.change(state => { state.sessionIndex = { task: null, summary, repeated: false, running: null } })
  }

  /** Forgets the task and the summary of the session index after the user took the consent back. */
  async sessionsOff() {
    await this.change(state => { state.sessionIndex = { task: null, summary: null, repeated: false, running: null } })
  }

  /** Starts the event turn that tells the summary of the first pass of the session index. */
  async nextSessionsEvent() {
    return this.change(async (state, tx) => {
      const summary = state.sessionIndex?.summary
      if (state.current || !summary) return null
      retain(state)
      clearPromptSuggestion(state.initiative)
      const repeated = state.sessionIndex.repeated === true
      // A repeat is an input of its own, so it gets a request ID of its own.
      const requestId = `sessions:${digest(summary)}${repeated ? ':repeat' : ''}`
      const mainRunId = randomUUID()
      const submissionId = await this.root.submit(tx, {
        type: 'input', requestId, content: `${message(`event.sessions${this.eventSuffix}`)}\n${JSON.stringify(summary)}`,
        entry: { kind: 'air.megachat.event', data: { type: 'sessions', ...summary } },
      })
      Object.assign(state.sessionIndex, { summary: null, repeated: false, running: { summary, repeated, mainRunId, interrupted: false } })
      const input = { digest: digest(summary), mainRunId, submissionId, status: 'running', admittedAt: Date.now() }
      state.inputs[requestId] = input
      state.current = { id: mainRunId, requestId, cancelling: false, kind: 'event' }
      return input
    })
  }

  /**
   * Records that the morning report of [date] needs no turn, because its period had no activity, or because the user
   * turned the report on after the start of that day. Gives false when the state has a report of [date].
   */
  async morningReportDone(date) {
    return this.change(state => {
      if (state.morningReport.lastDate === date) return false
      state.morningReport.lastDate = date
      return true
    })
  }

  /**
   * Stores the data of the morning report of [date] for its turn, and the date, so a restart sends no second report.
   * Gives false when the state has a report of [date].
   */
  async morningReportReady(date, data) {
    return this.change(state => {
      if (state.morningReport.lastDate === date) return false
      state.morningReport.lastDate = date
      state.morningReport.pending = { date, data, repeated: false }
      return true
    })
  }

  /**
   * Writes a note about the agent sessions that wait into the conversation, and the records of the sent notes, in one
   * commit. [plan] gets the records (`sessionNotes.records`, keyed by `noteKey`) and gives `{ due, changes, text }`
   * (see `planNotes`). The note is a message of the assistant in an entry of the kind `air.megachat.note`. Pi Durable
   * appends such a write at once and starts no run, so the note costs no model request, and the next turn of the main
   * agent sees it. The write must not land inside a run: a note between a tool result and the next model request would
   * end the context with a message of the assistant. So the note goes out only when no turn runs, no run is live and the
   * inbox is empty. Else the note waits for the next check, and the records of the sessions in [plan.due] stay as they
   * are. Gives the count of the sessions in the note, or 0.
   */
  async sessionNote(plan, now) {
    // A check runs each minute. Without a note to write and without a changed record, it commits nothing.
    const before = await this.snapshot()
    const preview = plan(plain(before.sessionNotes?.records ?? {}))
    if (!Object.keys(preview.changes).length && (!preview.text || before.current)) return 0
    return this.change(async (state, tx) => {
      // A state of an earlier build has no records. A daemon of v0.3.0 keeps the field as it is.
      state.sessionNotes ??= { records: {} }
      const records = state.sessionNotes.records
      const { due, changes, text } = plan(plain(records))
      const idle = !state.current && (await tx.doc(LiveDoc, this.root.id)).run === undefined
        && (await tx.doc(InboxDoc, this.root.id)).items.length === 0
      let sent = 0
      if (text && idle) {
        await this.root.submit(tx, { type: 'write', requestId: `notes:${randomUUID()}`,
          entry: { kind: NOTE_KIND, data: { type: 'sessions', count: due.length }, model: [noteMessage(text, now)] } })
        for (const { key, row } of due) records[key] = { status: row.status, since: row.statusSince, left: false, notedAt: now }
        sent = due.length
      }
      Object.assign(records, changes)
      pruneRecords(records, now)
      return sent
    })
  }

  /**
   * Records the version [version] of the daemon at its start (see the capability `update`). The field `update` holds
   * the version of the last daemon, the last automatic stop, the release for which a stop gave no update, and the
   * message that waits for an idle conversation. A state of an earlier build has no
   * field: it gets the version with no message. Gives `{ notice, failed }`: the new message and the release of a stop
   * without an update, or `null`.
   */
  async recordVersion(version) {
    return this.change(state => {
      if (!state.update) {
        state.update = { version, stop: null, failed: null, notice: null }
        return { notice: null, failed: null }
      }
      const update = state.update
      let notice = null
      let failed = null
      if (higherVersion(version, update.version)) {
        notice = { from: baseVersion(update.version), to: baseVersion(version), notes: null }
        update.notice = notice
        update.failed = null
      }
      else if (update.stop && !higherVersion(version, update.stop.from)) {
        failed = update.stop.to
        update.failed = failed
      }
      update.version = version
      update.stop = null
      return { notice: notice && plain(notice), failed }
    })
  }

  /** Adds [notes] to the waiting message of [notice], when that message still waits. */
  async updateNotes(notice, notes) {
    return this.change(state => {
      const waiting = state.update?.notice
      if (waiting && waiting.from === notice.from && waiting.to === notice.to) waiting.notes = notes
    })
  }

  /** Records the automatic stop from [from] for the release [to] before the stop. */
  async updateStopped(from, to, now = Date.now()) {
    return this.change(state => {
      state.update ??= { version: from, stop: null, failed: null, notice: null }
      state.update.stop = { from, to, at: now }
    })
  }

  /**
   * Writes the waiting message after an update into the conversation, on its own: the daemon calls it after the start,
   * and no input of the user triggers it. The message is a note of Megachat: a fixed text without a model request. It
   * goes out only when no turn runs, no run is live and the inbox is empty, as a note about the sessions does, so it
   * never lands inside a run. The write and the clear of the waiting message are one commit, so the message goes out
   * once, also with no client connected: the conversation keeps it, and a client that connects later gets it with the
   * replay. Gives `true` when no message waits any more, and `false` when the message waits for an idle conversation.
   */
  async writeUpdateNote() {
    if (!(await this.snapshot())?.update?.notice) return true
    return this.change(async (state, tx) => {
      const notice = state.update?.notice
      if (!notice) return true
      if (state.current || (await tx.doc(LiveDoc, this.root.id)).run !== undefined
        || (await tx.doc(InboxDoc, this.root.id)).items.length > 0) return false
      await this.root.submit(tx, { type: 'write', requestId: `update:${randomUUID()}`,
        entry: { kind: NOTE_KIND, data: { type: 'update', from: notice.from, to: notice.to }, model: [noteMessage(updateNoteText(plain(notice)), Date.now())] } })
      state.update.notice = null
      return true
    })
  }

  /** Starts the turn of the morning report that waits. The turn runs only when no other turn runs. */
  async nextMorningReport() {
    return this.change(async (state, tx) => {
      const pending = state.morningReport?.pending
      if (state.current || !pending) return null
      retain(state)
      clearPromptSuggestion(state.initiative)
      const mainRunId = randomUUID()
      const requestId = `morning:${mainRunId}`
      const submissionId = await this.root.submit(tx, {
        type: 'input', requestId, content: `${message('event.morning')}\n${JSON.stringify(pending.data)}`,
        entry: { kind: 'air.megachat.event', data: { type: 'morning', date: pending.date } },
      })
      state.morningReport.pending = null
      state.morningReport.running = { ...pending, mainRunId }
      const input = { digest: digest(pending.data), mainRunId, submissionId, status: 'running', admittedAt: Date.now() }
      state.inputs[requestId] = input
      state.current = { id: mainRunId, requestId, cancelling: false, kind: 'morning' }
      return input
    })
  }

  async readRun(runId) {
    return this.change(state => {
      const run = state.runs[runId]
      requireCondition(run, 'missing')
      if (terminalStates.has(run.status)) run.reported = true
      const { carriedOutput, carriedTruncated, ...shown } = plain(run)
      return shown
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
      clearPromptSuggestion(state.initiative)
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
   * stopped it, or `interruptAutomaticTurn` already asked for a new report. A morning report or a summary of the
   * session index that a user message interrupted, or that failed for a reason that can go away, waits for one more
   * turn. The user can stop it for good. [central] is the last failure of Central, `{ cause, at }`. The input keeps
   * its cause code only when the failure came after the admission of the input, so a failure of an earlier turn does
   * not change the text of this turn.
   */
  async settleInput(mainRunId, status, reason, stopped, central) {
    await this.change(async (state, tx) => {
      if (state.current?.id !== mainRunId) return
      const input = state.inputs[state.current.requestId]
      if (state.current.cancelling) status = 'cancelled'
      // The model gets the stopped turn as a reply that the user stopped. The write lands before the next turn can start.
      if (status === 'cancelled' && stopped) {
        await this.root.submit(tx, { type: 'write', requestId: `stopped:${mainRunId}`,
          entry: { kind: STOPPED_KIND, data: { type: 'stopped' }, model: [noteMessage(stopped, Date.now())] } })
      }
      input.status = status
      // Each completed turn of the user counts for the reflection of the memory. At 10, a pass is due.
      const reflection = state.memoryReflection
      if (reflection && state.current.kind === 'user' && status === 'completed') {
        reflection.userTurns++
        if (reflection.userTurns >= REFLECTION_TURNS) reflection.due = true
      }
      // After a restart, the end of the last turn of the user gives the idle time of the working day.
      input.settledAt = Date.now()
      // Only a completed turn keeps its prompt suggestion. A delegation acknowledgment gets none, also when the main
      // agent admitted the child after the proposal.
      const suggestion = state.initiative.promptSuggestion
      if (suggestion?.turnId === state.current.requestId && (status !== 'completed'
        || Object.values(state.runs).some(run => run.mainRunId === mainRunId))) clearPromptSuggestion(state.initiative)
      const morning = state.current.kind === 'morning' ? state.morningReport.running : null
      if (morning) {
        const repeatable = morning.interrupted || status === 'interrupted' && (reason === undefined || repeatableReasons.has(reason))
        if (repeatable && !morning.repeated) state.morningReport.pending = { date: morning.date, data: morning.data, repeated: true }
        state.morningReport.running = null
      }
      const sessions = state.sessionIndex?.running?.mainRunId === mainRunId ? state.sessionIndex.running : null
      if (sessions) {
        const repeatable = sessions.interrupted || status === 'interrupted' && (reason === undefined || repeatableReasons.has(reason))
        // A new summary that came during the turn wins over the repeat.
        if (repeatable && !sessions.repeated && !state.sessionIndex.summary) Object.assign(state.sessionIndex, { summary: sessions.summary, repeated: true })
        state.sessionIndex.running = null
      }
      if (status === 'interrupted') {
        // The state keeps only the reason code. The detail of the reason can hold the text of a provider.
        if (typeof reason === 'string') input.reason = reason.slice(0, 64)
        if (typeof central?.cause === 'string' && central.at >= input.admittedAt) input.cause = central.cause.slice(0, 64)
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
      if (state.current.kind === 'morning' && state.morningReport.running) state.morningReport.running.interrupted = true
      if (state.sessionIndex?.running?.mainRunId === state.current.id) state.sessionIndex.running.interrupted = true
      return true
    })
  }

  /**
   * Admits a child run. A new task without a named agent gets [defaultAgent], the setting `children.agent`. The digest
   * holds only [args], so a repeated request still finds its run after a change of the setting.
   */
  async admitChild(requestId, args, { defaultAgent = 'claude', showInProject = false } = {}) {
    requireCondition(typeof args.prompt === 'string' && args.prompt.length > 0 && args.prompt.length <= 64000)
    requireCondition(args.title === undefined || typeof args.title === 'string' && args.title.trim().length > 0 && args.title.length <= 60)
    const hash = digest(args)
    // The log line of the start. A repeated request makes no line, and a commit that runs again makes one.
    let started
    const admitted = await this.change(state => {
      started = undefined
      const old = Object.values(state.runs).find(run => run.requestId === requestId)
      if (old) {
        requireCondition(old.digest === hash, 'conflict')
        return plain(old)
      }
      requireCondition(state.current && !state.current.cancelling, 'inactive')
      requireCondition(!automaticKinds.has(state.current.kind), 'proposalOnly')
      requireCondition(isDirectoryOf(state, args.cwd), 'workspace')
      requireCondition(Object.values(state.runs).filter(run => run.mainRunId === state.current.id).length < maxChildRunsPerTask,
        'turnChildLimit', maxChildRunsPerTask)
      requireCondition(Object.values(state.runs).filter(run => !terminalStates.has(run.status)).length < maxUnfinishedRuns,
        'unfinishedLimit', maxUnfinishedRuns)
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
        // A pi child has no session file of Claude Code or Codex, so Air has no session of it to hide. With
        // `children.showInProject`, a new session stays in the session list of its project. A next run keeps the choice.
        serviceSession: agent === 'pi' ? false : previous?.serviceSession ?? (!args.providerSessionId && !showInProject),
        generation: null, pid: null, output: '', truncated: false,
        cancelRequested: false, createdAt: Date.now(), closed: false,
      }
      state.runs[run.id] = run
      started = { kind: args.childSessionId ? 'send' : args.providerSessionId ? 'resume' : 'spawn', run: plain(run) }
      return plain(run)
    })
    if (started) logRunStart(started.run, started.kind)
    return admitted
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
      requireCondition(!automaticKinds.has(state.current.kind), 'steerEvent')
      const run = Object.values(state.runs).findLast(run => run.childSessionId === args.childSessionId)
      requireCondition(run && !run.closed, 'missing')
      // The project rules stay for a child that works: its directory can leave the list after its start.
      requireCondition(isDirectoryOf(state, run.cwd), 'workspace')
      requireCondition(!terminalStates.has(run.status), 'childIdle')
      requireCondition(!run.cancelRequested, 'inactive')
      requireCondition(steerCount(state, run) < maxSteers, 'steerLimit', maxSteers)
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

  /**
   * Changes the run [runId] when its status is one of [expected]. [errorClass] says why the run ended on an error (see
   * `logRunEnd`). A run that gets a terminal status writes the lines for its end to the log, and its continuation, when
   * it has one, writes the line of its start.
   */
  async transition(runId, expected, changes, { errorClass } = {}) {
    // The error text of a run can hold a text of the child.
    if (typeof changes.error === 'string') changes = { ...changes, error: redactOwnSecrets(changes.error, this.secrets) }
    const filter = this.childTexts.get(runId)
    // The end of the text of the child that the filter held back goes to the output at the end of the run, so a
    // continuation and the report get the whole output.
    const settle = run => { if (filter?.generation === run.generation) appendOutput(run, filter.text.end()) }
    let finished
    // The data of the log lines. A commit can run its function again, so the lines go out after the commit.
    let ending
    let continuation
    const changed = await this.change(state => {
      finished = false
      ending = undefined
      continuation = undefined
      const run = state.runs[runId]
      requireCondition(run, 'missing')
      if (!expected.includes(run.status)) return false
      if (changes.status === 'dispatched' && run.cancelRequested) {
        settle(run)
        run.status = 'cancelled'
        finished = true
        ending = endOf(run, 'cancelled')
        return false
      }
      const previousStatus = run.status
      Object.assign(run, changes)
      if (changes.providerSessionId) recordServiceSession(state, run)
      if (run.status === 'dispatched') run.dispatched = true
      if (terminalStates.has(run.status)) {
        settle(run)
        finished = true
        run.finishedAt = Date.now()
        dropCarriedOutput(run)
        ending = endOf(run, run.status, { errorClass })
        continuation = scheduleResume(state, run, previousStatus, this.resumeDelayMs) ?? followSteers(state, run)
        if (continuation) ending.resumedBy = continuation.id
        for (const permission of Object.values(state.permissions)) {
          if (permission.runId === runId && permission.status === 'pending') permission.status = 'stale'
        }
      }
      return true
    })
    if (finished && this.childTexts.get(runId) === filter) this.childTexts.delete(runId)
    if (ending) logRunEnd(ending)
    if (continuation) logRunStart(continuation.run, continuation.kind)
    return changed
  }

  /**
   * Keeps the text that the agent wrote, at most the last 64,000 characters: the result of a long run is at its end.
   * The text goes through `redactOwnSecrets`. A secret can come in two chunks, so the filter holds back the last word
   * of the text, and the end of the run adds it (see `ChildTextFilter`). A [whole] text, such as an answer of a pi
   * child, is a complete message, so nothing of it waits. Each other update changes no state, so it costs no commit of
   * the document.
   */
  async appendUpdate(runId, generation, update, { whole = false } = {}) {
    if (update.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text') return
    let filter = this.childTexts.get(runId)
    if (!whole && filter?.generation !== generation) {
      filter = { generation, text: new ChildTextFilter(this.secrets) }
      this.childTexts.set(runId, filter)
    }
    const text = whole ? redactOwnSecrets(update.content.text, this.secrets) : filter.text.push(update.content.text)
    if (!text) return
    await this.change(state => {
      const run = state.runs[runId]
      if (!run || run.generation !== generation || terminalStates.has(run.status)) return
      appendOutput(run, text)
    })
  }

  async requestPermission(runId, generation, request) {
    return this.change(state => {
      const run = state.runs[runId]
      requireCondition(run && run.generation === generation && !run.cancelRequested && !terminalStates.has(run.status), 'stale')
      requireCondition(JSON.stringify(request).length <= 32000 && Array.isArray(request.options) && request.options.length > 0)
      requireCondition(Object.values(state.permissions).filter(value => value.runId === runId).length < maxPermissionsPerRun,
        'permissionLimit', maxPermissionsPerRun)
      retain(state)
      const id = randomUUID()
      // Each text of the tool call can hold a text of the child. The ID of the tool call and the options stay, so the
      // dialog and the answer work as before.
      const toolCall = request.toolCall && typeof request.toolCall === 'object' ? request.toolCall : undefined
      const kept = toolCall ? { ...request, toolCall: { ...eachText(toolCall, text => redactOwnSecrets(text, this.secrets)),
        ...(toolCall.toolCallId === undefined ? {} : { toolCallId: toolCall.toolCallId }) } } : request
      state.permissions[id] = { id, runId, generation, request: kept, status: 'pending', decision: null, createdAt: Date.now() }
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
      requireCondition(permissionOpen(state, permission), 'stale')
      permission.decision = decision
      permission.status = 'answered'
      state.runs[permission.runId].status = 'running'
    })
  }

  async cancel(mainRunId, runId = null) {
    let ended
    await this.change(state => {
      ended = []
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
          if (run.status === 'admitted') {
            run.status = 'cancelled'
            ended.push(endOf(run, 'cancelled'))
          }
        }
      }
    })
    for (const end of ended) logRunEnd(end)
  }

  /**
   * Cancels one child run for the Stop action of its row in the chat. The stop needs no turn: the user stops the run
   * also while no turn runs. The stop goes to the last continuation of the run. The run services then end the run, as
   * for `agents_cancel`, and its pending permission requests become stale. The run gets no continuation, and its
   * report gives `cancelled`. Tells whether the stop is accepted: an unknown run and a finished run give `false`.
   */
  async stopChild(runId) {
    let ending
    const stopped = await this.change(state => {
      ending = undefined
      let run = Object.hasOwn(state.runs, runId) ? state.runs[runId] : null
      // A report can keep a run while `retain` drops its continuation. So the walk stops at a dropped run.
      while (run && state.runs[run.resumedBy]) run = state.runs[run.resumedBy]
      if (!run || terminalStates.has(run.status)) return false
      run.cancelRequested = true
      if (run.status === 'admitted') {
        run.status = 'cancelled'
        run.finishedAt = Date.now()
        ending = endOf(run, 'cancelled')
      }
      return true
    })
    if (ending) logRunEnd(ending)
    return stopped
  }

  async closeChild(childSessionId) {
    await this.change(state => {
      requireCondition(state.current?.kind !== 'morning', 'morningReport')
      const runs = Object.values(state.runs).filter(run => run.childSessionId === childSessionId)
      requireCondition(runs.length > 0, 'missing')
      requireCondition(runs.every(run => terminalStates.has(run.status)), 'busy')
      for (const run of runs) run.closed = true
    })
  }

  async recover() {
    // The data of the log lines of the runs that the restart ended, in the order of the runs.
    let lines
    await this.change(state => {
      lines = []
      for (const run of Object.values(state.runs)) {
        if (terminalStates.has(run.status)) dropCarriedOutput(run)
        if (terminalStates.has(run.status) || run.status === 'admitted') continue
        // Pi Durable continues the conversation of a dispatched pi run after the restart, and the pi run service follows it.
        if (run.agent === 'pi' && run.status === 'dispatched') continue
        const previousStatus = run.status
        run.status = run.cancelRequested ? 'cancelled' : 'interrupted'
        run.finishedAt = Date.now()
        const line = { end: endOf(run, run.status) }
        if (run.status === 'interrupted') {
          run.error ??= message('error.interrupted')
          line.end = endOf(run, run.status, { errorClass: 'daemonRestart' })
          line.continuation = scheduleResume(state, run, previousStatus, this.resumeDelayMs, true)
          if (line.continuation) line.end.resumedBy = line.continuation.id
        }
        lines.push(line)
      }
      for (const permission of Object.values(state.permissions)) {
        if (permission.status === 'pending') permission.status = 'stale'
      }
    })
    for (const { end, continuation } of lines) {
      logRunEnd(end)
      if (continuation) logRunStart(continuation.run, continuation.kind)
    }
  }
}
