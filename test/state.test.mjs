import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { findSteer, maxChildRunsPerTask, maxPermissionsPerRun, maxSteers, maxUnfinishedRuns, MegachatState, permissionOpen } from '../src/MegachatState.mjs'
import { message } from '../src/messages.mjs'
import { waitForState } from '../src/waitForState.mjs'

async function open(storage = new MemoryStorage()) {
  const models = createModels()
  const faux = fauxProvider()
  faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage('Done')))
  models.setProvider(faux.provider)
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, BACKGROUND_CONTEXT)
  const model = faux.getModel()
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id } } })
  const state = new MegachatState(harness, root)
  await state.initialize()
  await state.addWorkspace('/workspace')
  return { harness, state }
}

test('a resumed provider session has one active run and keeps its provider on follow-up', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('main', 'Continue a session')
  const args = { cwd: '/workspace', agent: 'codex', providerSessionId: 'existing', prompt: 'Continue' }
  const run = await state.admitChild('resume', args)
  assert.equal(run.serviceSession, false)
  await assert.rejects(state.admitChild('duplicate-resume', args), { code: 'busy' })
  await assert.rejects(state.admitChild('wrong-project', { ...args, cwd: '/other' }), { code: 'workspace' })
  await assert.rejects(state.admitChild('busy-follow-up', { cwd: args.cwd, childSessionId: run.childSessionId, prompt: 'Again' }), { code: 'childBusy' })
  await state.transition(run.id, ['admitted'], { status: 'completed' })
  const next = await state.admitChild('follow-up', { cwd: args.cwd, childSessionId: run.childSessionId, prompt: 'Again' })
  assert.equal(next.agent, 'codex')
  assert.equal(next.providerSessionId, 'existing')
  assert.equal(next.serviceSession, false)
  await state.transition(next.id, ['admitted'], { status: 'completed' })
  await state.admitChild('resume-new-handle', args)
  await assert.rejects(state.admitChild('old-handle', { cwd: args.cwd, childSessionId: run.childSessionId, prompt: 'Again' }), { code: 'busy' })
})

test('duplicate input returns one admission and rejects conflicting arguments', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  const [first, duplicate] = await Promise.all([state.submit('request', 'Hello'), state.submit('request', 'Hello')])
  assert.equal(first.submissionId, duplicate.submissionId)
  assert.equal(first.mainRunId, duplicate.mainRunId)
  await assert.rejects(state.submit('request', 'Different'), { code: 'conflict' })
  await assert.rejects(state.submit('another', 'Hello'), { code: 'busy' })
})

test('admission survives a crash boundary before its tool result is stored', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-state-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const database = join(directory, 'state.sqlite')
  let opened = await open(await openNodeSqliteStorage(database))
  await opened.state.submit('main', 'Work')
  const original = await opened.state.admitChild('tool:1:spawn', { cwd: '/workspace', prompt: 'Read one file' })
  await opened.harness.close(BACKGROUND_CONTEXT)
  opened = await open(await openNodeSqliteStorage(database))
  t.after(() => opened.harness.close(BACKGROUND_CONTEXT))
  const replay = await opened.state.admitChild('tool:1:spawn', { cwd: '/workspace', prompt: 'Read one file' })
  assert.equal(replay.id, original.id)
  assert.equal(replay.childSessionId, original.childSessionId)
  assert.equal(Object.keys((await opened.state.snapshot()).runs).length, 1)
  await assert.rejects(opened.state.admitChild('tool:1:spawn', { cwd: '/workspace', prompt: 'Another task' }), { code: 'conflict' })
})

test('uncertain dispatch is interrupted and its old permission cannot be answered', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('main', 'Work')
  const run = await state.admitChild('tool', { cwd: '/workspace', prompt: 'Work' })
  await state.transition(run.id, ['admitted'], { status: 'dispatched', generation: 'old-process' })
  const permission = await state.requestPermission(run.id, 'old-process', {
    options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }], toolCall: { title: 'Write a file' },
  })
  await state.recover()
  const snapshot = await state.snapshot()
  assert.equal(snapshot.runs[run.id].status, 'interrupted')
  assert.equal(snapshot.permissions[permission].status, 'stale')
  await assert.rejects(state.respondPermission(permission, 'yes'), { code: 'stale' })
})

test('an interrupted dispatch continues its provider session and the report links both runs', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('main', 'Work')
  const run = await state.admitChild('tool', { cwd: '/workspace', prompt: 'Implement it' })
  await state.transition(run.id, ['admitted'], { status: 'ready', generation: 'old', providerSessionId: 'provider' })
  await state.transition(run.id, ['ready'], { status: 'dispatched' })
  const before = Date.now()
  await state.recover()
  const snapshot = await state.snapshot()
  const old = snapshot.runs[run.id]
  const next = snapshot.runs[old.resumedBy]
  assert.equal(old.status, 'resumed')
  assert.equal(old.error, message('error.interrupted'))
  assert.equal(next.status, 'admitted')
  assert.equal(next.prompt, message('child.continue'))
  assert.equal(next.task, 'Implement it')
  assert.equal(next.providerSessionId, 'provider')
  assert.equal(next.childSessionId, run.childSessionId)
  assert.equal(next.resumeOf, run.id)
  assert.equal(next.resumeAttempt, 1)
  assert.ok(next.notBefore >= before + 5000)
  await state.settleInput(snapshot.current.id, 'completed')
  await state.nextChildResults()
  const [report] = Object.values((await state.snapshot()).inputs).filter(input => input.resultRunIds)
  assert.deepEqual(report.resultRunIds, [run.id])
  assert.equal((await state.readRun(run.id)).resumedBy, next.id)
})


test('a result report cut by a daemon stop is sent once more, and a cancelled or limited report is not', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  let turn = 0
  const finishedRun = async () => {
    const main = await state.submit(`main-${++turn}`, 'Work')
    const run = await state.admitChild(`tool-${turn}`, { cwd: '/workspace', prompt: 'Implement it' })
    await state.transition(run.id, ['admitted'], { status: 'completed' })
    await state.settleInput(main.mainRunId, 'completed')
    return run
  }
  const report = async id => (await state.snapshot()).inputs[`children:${id}`]
  const reported = async run => (await state.snapshot()).runs[run.id].reported

  state.reportRetryDelayMs = 0
  const stopped = await finishedRun()
  const first = await state.nextChildResults()
  await state.settleInput(first.mainRunId, 'interrupted', 'interrupted')
  assert.equal((await report(first.mainRunId)).reason, 'interrupted')
  assert.equal(await reported(stopped), false)
  const second = await state.nextChildResults()
  assert.deepEqual(second.resultRunIds, [stopped.id])
  await state.settleInput(second.mainRunId, 'interrupted', 'interrupted')
  assert.equal(await reported(stopped), true)
  assert.equal(await state.nextChildResults(), null)

  const limited = await finishedRun()
  const third = await state.nextChildResults()
  await state.settleInput(third.mainRunId, 'interrupted', 'turn_limit')
  assert.equal((await report(third.mainRunId)).reason, 'turn_limit')
  assert.equal(await reported(limited), true)

  const cancelled = await finishedRun()
  const fourth = await state.nextChildResults()
  await state.cancel(fourth.mainRunId)
  await state.settleInput(fourth.mainRunId, 'interrupted', 'aborted')
  assert.equal((await report(fourth.mainRunId)).status, 'cancelled')
  assert.equal(await reported(cancelled), true)

  state.reportRetryDelayMs = 60000
  const delayed = await finishedRun()
  const before = Date.now()
  const fifth = await state.nextChildResults()
  await state.settleInput(fifth.mainRunId, 'interrupted', 'model_error')
  assert.equal(await reported(delayed), false)
  assert.ok((await state.snapshot()).runs[delayed.id].reportAfter >= before + 60000)
  assert.equal(await state.nextChildResults(), null)
})

test('a summary of the session index that failed for a reason that can go away runs again one time, and a stop of the user ends it', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  const summary = passId => ({ passId, sessions: 1, projects: 1, entries: 3, agents: { claude: 1, codex: 0, pi: 0 }, unfinished: [] })
  const index = async () => (await state.snapshot()).sessionIndex

  await state.sessionsIndexed(summary('pass-1'))
  const first = await state.nextSessionsEvent()
  assert.equal((await index()).running.mainRunId, first.mainRunId)
  await state.settleInput(first.mainRunId, 'interrupted', 'model_error')
  assert.deepEqual(await index(), { task: null, summary: summary('pass-1'), repeated: true, running: null })
  const second = await state.nextSessionsEvent()
  assert.ok(Object.keys((await state.snapshot()).inputs).includes(`sessions:${second.digest}:repeat`))
  await state.settleInput(second.mainRunId, 'interrupted', 'model_error')
  assert.deepEqual(await index(), { task: null, summary: null, repeated: false, running: null }, 'A second failure ends the summary')
  assert.equal(await state.nextSessionsEvent(), null)

  // A reason that does not go away, and a stop of the user, end the summary at once.
  await state.sessionsIndexed(summary('pass-2'))
  const limited = await state.nextSessionsEvent()
  await state.settleInput(limited.mainRunId, 'interrupted', 'turn_limit')
  assert.equal((await index()).summary, null)
  await state.sessionsIndexed(summary('pass-3'))
  const stopped = await state.nextSessionsEvent()
  await state.cancel(stopped.mainRunId)
  await state.settleInput(stopped.mainRunId, 'interrupted', 'aborted')
  assert.equal((await index()).summary, null)

  // A user message interrupts the turn, and the summary waits for one more turn.
  await state.sessionsIndexed(summary('pass-4'))
  const interrupted = await state.nextSessionsEvent()
  assert.equal(await state.interruptAutomaticTurn(), true)
  await state.settleInput(interrupted.mainRunId, 'interrupted', 'aborted')
  assert.deepEqual(await index(), { task: null, summary: summary('pass-4'), repeated: true, running: null })
})

test('a run that never reached its provider is dispatched again and continuations are capped', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  state.resumeDelayMs = 0
  await state.submit('main', 'Work')
  const run = await state.admitChild('tool', { cwd: '/workspace', prompt: 'Implement it' })
  await state.transition(run.id, ['admitted'], { status: 'launching', generation: 'old' })
  await state.recover()
  let snapshot = await state.snapshot()
  const first = snapshot.runs[snapshot.runs[run.id].resumedBy]
  assert.equal(first.prompt, 'Implement it')
  assert.equal(first.task, undefined)
  assert.equal(first.providerSessionId, null)
  assert.equal(Object.keys(snapshot.runs).length, 2)
  await state.recover()
  assert.equal(Object.keys((await state.snapshot()).runs).length, 2)
  await state.transition(first.id, ['admitted'], { status: 'ready', generation: 'next', providerSessionId: 'provider' })
  await state.transition(first.id, ['ready'], { status: 'dispatched' })
  await state.transition(first.id, ['dispatched'], { status: 'interrupted', error: message('error.interrupted') })
  snapshot = await state.snapshot()
  const second = snapshot.runs[snapshot.runs[first.id].resumedBy]
  assert.equal(second.prompt, message('child.continue'))
  assert.equal(second.task, 'Implement it')
  assert.equal(second.resumeAttempt, 2)
  await state.transition(second.id, ['admitted'], { status: 'interrupted', error: message('error.interrupted') })
  snapshot = await state.snapshot()
  assert.equal(snapshot.runs[second.id].status, 'interrupted')
  assert.equal(snapshot.runs[second.id].resumedBy, undefined)
  assert.equal(Object.keys(snapshot.runs).length, 3)
})

test('a planned stop of the daemon continues a run without the count of an attempt', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  state.resumeDelayMs = 0
  await state.submit('main', 'Work')
  let run = await state.admitChild('tool', { cwd: '/workspace', prompt: 'Implement it' })
  // More stops than the limit of automatic continuations.
  for (let stop = 0; stop < 4; stop++) {
    await state.transition(run.id, ['admitted'], { status: 'ready', generation: `daemon-${stop}`, providerSessionId: 'provider' })
    await state.transition(run.id, ['ready'], { status: 'dispatched' })
    await state.transition(run.id, ['dispatched'], { status: 'interrupted', error: message('error.interrupted'), plannedStop: true })
    const snapshot = await state.snapshot()
    assert.equal(snapshot.runs[run.id].status, 'resumed')
    run = snapshot.runs[snapshot.runs[run.id].resumedBy]
    assert.equal(run.resumeAttempt, 0)
    assert.equal(run.task, 'Implement it')
  }
  await state.transition(run.id, ['admitted'], { status: 'interrupted', error: message('error.interrupted') })
  const snapshot = await state.snapshot()
  assert.equal(snapshot.runs[snapshot.runs[run.id].resumedBy].resumeAttempt, 1)
})

test('a cancelled or limited run is not continued and cancellation follows a continuation', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('main', 'Work')
  const cancelled = await state.admitChild('cancelled', { cwd: '/workspace', prompt: 'Stop me' })
  await state.transition(cancelled.id, ['admitted'], { status: 'ready', generation: 'old', providerSessionId: 'one' })
  await state.transition(cancelled.id, ['ready'], { status: 'dispatched' })
  const limited = await state.admitChild('limited', { cwd: '/workspace', prompt: 'Too long' })
  await state.transition(limited.id, ['admitted'], { status: 'interrupted', error: message('error.limit', 30), autoResume: false })
  const resumed = await state.admitChild('resumed', { cwd: '/workspace', prompt: 'Continue me' })
  await state.transition(resumed.id, ['admitted'], { status: 'ready', generation: 'old', providerSessionId: 'two' })
  await state.transition(resumed.id, ['ready'], { status: 'dispatched' })
  let snapshot = await state.snapshot()
  await state.cancel(snapshot.current.id, cancelled.id)
  await state.recover()
  snapshot = await state.snapshot()
  assert.equal(snapshot.runs[cancelled.id].status, 'cancelled')
  assert.equal(snapshot.runs[limited.id].status, 'interrupted')
  assert.equal(Object.keys(snapshot.runs).length, 4)
  const next = snapshot.runs[resumed.id].resumedBy
  await state.cancel(snapshot.current.id, resumed.id)
  assert.equal((await state.snapshot()).runs[next].status, 'cancelled')
})

test('a permission stays pending without a viewer and its answer is durable', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('main', 'Work')
  const run = await state.admitChild('tool', { cwd: '/workspace', prompt: 'Work' })
  await state.transition(run.id, ['admitted'], { status: 'running', generation: 'process' })
  const id = await state.requestPermission(run.id, 'process', {
    options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Deny' }],
    toolCall: { title: 'Write a file' },
  })
  assert.equal((await state.snapshot()).permissions[id].status, 'pending')
  const answer = waitForState(state, value => value.permissions[id].status === 'answered' ? value.permissions[id] : undefined)
  await state.respondPermission(id, 'yes')
  assert.equal((await answer).decision, 'yes')
  await state.respondPermission(id, 'yes')
  await assert.rejects(state.respondPermission(id, 'no'), { code: 'conflict' })
  await state.transition(run.id, ['running'], { status: 'completed' })
  await state.respondPermission(id, 'yes')
})

test('a permission request is open exactly while respondPermission takes a new answer for it', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('main', 'Work')
  const request = { options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }], toolCall: { title: 'Write a file' } }
  /** A run that waits for one permission request, after [change] of the run. Gives the result of the check and of the answer. */
  const check = async (name, change) => {
    const run = await state.admitChild(`tool:${name}`, { cwd: '/workspace', prompt: name })
    await state.transition(run.id, ['admitted'], { status: 'running', generation: 'process' })
    const id = await state.requestPermission(run.id, 'process', request)
    await change(run, id)
    const snapshot = await state.snapshot()
    const open = permissionOpen(snapshot, snapshot.permissions[id])
    const accepted = await state.respondPermission(id, 'yes').then(() => true, error => error.code)
    return [name, open, accepted]
  }
  const results = [
    await check('pending', async () => {}),
    // A stop of the child that the run service did not end yet.
    await check('stop', run => state.stopChild(run.id)),
    await check('generation', run => state.transition(run.id, ['approval'], { generation: 'restarted' })),
    await check('ended', run => state.transition(run.id, ['approval'], { status: 'failed' })),
    await check('recovered', () => state.recover()),
  ]
  assert.deepEqual(results, [['pending', true, true], ['stop', false, 'stale'], ['generation', false, 'stale'],
    ['ended', false, 'stale'], ['recovered', false, 'stale']])
  const answered = Object.values((await state.snapshot()).permissions).find(permission => permission.status === 'answered')
  assert.equal(permissionOpen(await state.snapshot(), answered), false)
  assert.equal(permissionOpen(await state.snapshot(), undefined), false)
})

test('cancellation wins the dispatch boundary and retained output stays bounded', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  const main = await state.submit('main', 'Work')
  const run = await state.admitChild('tool', { cwd: '/workspace', prompt: 'Work' })
  await state.transition(run.id, ['admitted'], { status: 'ready', generation: 'process' })
  for (let index = 0; index < 8; index++) {
    await state.appendUpdate(run.id, 'process', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${String(index).repeat(15999)}\n` } })
  }
  // An update without text of the agent, such as a tool call, changes no state.
  const before = await state.snapshot()
  await state.appendUpdate(run.id, 'process', { sessionUpdate: 'tool_call', toolCallId: 'call', title: 'x'.repeat(1000) })
  const snapshot = await state.snapshot()
  assert.deepEqual(snapshot, before)
  // The end of the output stays: the result of a long run is at its end.
  assert.equal(snapshot.runs[run.id].output, ['4', '5', '6', '7'].map(digit => `${digit.repeat(15999)}\n`).join(''))
  assert.equal(snapshot.runs[run.id].truncated, true)
  assert.equal('updates' in snapshot.runs[run.id], false)
  assert.equal('updates' in await state.readRun(run.id), false)
  await state.appendUpdate(run.id, 'process', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${'😀'.repeat(32001)}\n` } })
  const emoji = (await state.snapshot()).runs[run.id].output
  assert.ok(emoji.length <= 64000)
  assert.equal(emoji.replaceAll('😀', ''), '\n')
  await state.cancel(main.mainRunId)
  assert.equal(await state.transition(run.id, ['ready'], { status: 'dispatched' }), false)
  assert.equal((await state.snapshot()).runs[run.id].status, 'cancelled')
})

test('cancellation prevents new delegation and cannot affect a later main run', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  const first = await state.submit('first', 'Work')
  const run = await state.admitChild('tool', { cwd: '/workspace', prompt: 'Work' })
  await state.cancel(first.mainRunId)
  assert.equal((await state.snapshot()).runs[run.id].status, 'cancelled')
  await assert.rejects(state.admitChild('later-tool', { cwd: '/workspace', prompt: 'Work' }), { code: 'inactive' })
  await state.settleInput(first.mainRunId, 'cancelled')
  const second = await state.submit('second', 'Work')
  await assert.rejects(state.cancel(first.mainRunId), { code: 'inactive' })
  assert.equal((await state.snapshot()).current.id, second.mainRunId)
})

test('a later user turn can cancel a background task without cancelling its own turn', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  const first = await state.submit('first', 'Work')
  const child = await state.admitChild('child', { cwd: '/workspace', prompt: 'Work' })
  await state.settleInput(first.mainRunId, 'completed')
  const second = await state.submit('second', 'Cancel the earlier task')
  await state.cancel(second.mainRunId, child.id)
  const snapshot = await state.snapshot()
  assert.equal(snapshot.runs[child.id].status, 'cancelled')
  assert.equal(snapshot.inputs.first.status, 'completed')
  assert.equal(snapshot.current.id, second.mainRunId)
  assert.equal(snapshot.current.cancelling, false)
  await assert.rejects(state.cancel(first.mainRunId, child.id), { code: 'inactive' })
})


test('reopening a conversation applies the selected main model and keeps the conversation', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-model-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const database = join(directory, 'state.sqlite')
  const models = createModels()
  const firstModel = { provider: 'anthropic', modelId: 'claude-sonnet-5-5' }
  let service = await PiMegachatService.open(await openNodeSqliteStorage(database), models, firstModel)
  const id = service.root.id
  await service.state.addWorkspace('/workspace')
  await service.close()
  service = await PiMegachatService.open(await openNodeSqliteStorage(database), models)
  t.after(() => service.close())
  assert.equal(service.root.id, id)
  assert.equal((await service.root.agent(BACKGROUND_CONTEXT)).model.modelId, 'claude-opus-5-5')
  assert.ok((await service.state.snapshot()).workspaces.includes('/workspace'))
})

test('three refusals survive restart and a duplicate feedback does not spend another alternative', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-proposals-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const database = join(directory, 'state.sqlite')
  let opened = await open(await openNodeSqliteStorage(database))
  for (let index = 0; index < 3; index++) {
    assert.equal((await opened.state.proposal(`proposal-${index}`, `Next step ${index}`)).allowed, true)
    const feedback = await opened.state.feedback(`feedback-${index}`, 'declined')
    assert.equal(feedback.declines, index + 1)
    assert.deepEqual(await opened.state.feedback(`feedback-${index}`, 'declined'), feedback)
  }
  await opened.harness.close(BACKGROUND_CONTEXT)
  opened = await open(await openNodeSqliteStorage(database))
  t.after(() => opened.harness.close(BACKGROUND_CONTEXT))
  assert.equal((await opened.state.proposal('fourth', 'One more')).allowed, false)
  // An automatic turn does not reset the count of the refusals, and it cannot start work.
  await opened.state.sessionsIndexed({ passId: 'pass-1', sessions: 1, projects: 1, entries: 3, agents: { claude: 1, codex: 0, pi: 0 }, unfinished: [] })
  assert.ok(await opened.state.nextSessionsEvent())
  assert.equal((await opened.state.proposal('after-event', 'Review the sessions')).allowed, false)
  await assert.rejects(opened.state.admitChild('automatic-work', { cwd: '/workspace', prompt: 'Change a file' }), { code: 'proposalOnly' })
  assert.equal((await opened.state.feedback('new-task', 'accepted')).allowed, true)
  assert.equal((await opened.state.proposal('after-task', 'Review the sessions')).allowed, true)
})

test('explicit silence suppresses proposals until the user asks to resume', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.feedback('stop', 'silence')
  await state.feedback('task', 'accepted')
  assert.equal((await state.proposal('while-silent', 'Next')).allowed, false)
  await state.feedback('resume', 'resume')
  assert.equal((await state.proposal('after-resume', 'Next')).allowed, true)
})

test('a state with the waiting changes of the project events of v0.3.0 opens, and the changes start no turn', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-project-events-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const database = join(directory, 'state.sqlite')
  const models = createModels()
  const faux = fauxProvider()
  const prompts = []
  faux.setResponses(Array.from({ length: 10 }, () => context => {
    prompts.push(JSON.stringify(context.messages.at(-1)))
    return fauxAssistantMessage('Done')
  }))
  models.setProvider(faux.provider)
  const model = { provider: faux.getModel().provider, modelId: faux.getModel().id }
  let service = await PiMegachatService.open(await openNodeSqliteStorage(database), models, model)
  await service.state.addWorkspace('/workspace')
  // v0.3.0 kept the last revision of each project and the change that waited for its turn.
  await service.state.change(state => {
    state.initiative.projects = { '/workspace': { revision: 'one', notifiedAt: Date.now() } }
    state.initiative.pending = { '/workspace': { cwd: '/workspace', revision: 'one', paths: ['src/main.kt'] } }
  })
  await service.close()
  service = await PiMegachatService.open(await openNodeSqliteStorage(database), models, model)
  t.after(() => service.close())
  const opened = await service.state.snapshot()
  // The fields stay as empty objects, because a daemon of v0.3.0 can open the state again and reads them.
  assert.deepEqual([opened.initiative.projects, opened.initiative.pending], [{}, {}])
  await service.resume()
  // The summary of the session index is the next automatic turn. No turn of a project event comes before it.
  await service.state.sessionsIndexed({ passId: 'pass-1', sessions: 1, projects: 1, entries: 3, agents: { claude: 1, codex: 0, pi: 0 }, unfinished: [] })
  const state = await waitForState(service.state, value => !value.current && Object.keys(value.inputs).length ? value : undefined)
  assert.deepEqual(Object.keys(state.inputs).map(key => key.split(':')[0]), ['sessions'])
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /Megachat finished the first import of the past sessions/)
})

test('the model reads retained history after context replacement and a restart', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-memory-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const database = join(directory, 'state.sqlite')
  const models = createModels()
  const fake = fauxProvider()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const selected = { provider: model.provider, modelId: model.id }
  let service = await PiMegachatService.open(await openNodeSqliteStorage(database), models, selected)
  fake.setResponses([fauxAssistantMessage('Saved.')])
  await service.resume()
  await service.submit('yesterday', 'The project codename is Juniper-742.')
  await waitForState(service.state, state => !state.current ? true : undefined)
  await service.root.reset('Earlier details are outside the current context.', BACKGROUND_CONTEXT)
  await service.close()
  service = await PiMegachatService.open(await openNodeSqliteStorage(database), models, selected)
  t.after(() => service.close())
  fake.setResponses([
    transcript => {
      assert.ok(!JSON.stringify(transcript).includes('Juniper-742'))
      assert.ok(JSON.stringify(transcript).includes('pi-durable'))
      return fauxAssistantMessage(fauxToolCall('agents_history', { query: 'codename' }), { stopReason: 'toolUse' })
    },
    transcript => {
      assert.ok(JSON.stringify(transcript).includes('Juniper-742'))
      return fauxAssistantMessage('The codename was Juniper-742.')
    },
  ])
  await service.resume()
  await service.submit('recall', 'What was the project codename?')
  await waitForState(service.state, state => !state.current ? true : undefined)
  const history = await service.history({ query: 'Juniper-742' })
  assert.ok(history.entries.some(entry => entry.role === 'user' && Number.isFinite(Date.parse(entry.timestamp))))
  assert.ok(history.entries.some(entry => entry.role === 'assistant' && entry.text === 'The codename was Juniper-742.'))
  assert.equal(history.nextBeforeEntryId, null)
  assert.ok(history.timeZone)
})


test('history lookup pages beyond a page without matches and marks long excerpts', { timeout: 10000 }, async t => {
  const service = await PiMegachatService.open(new MemoryStorage(), createModels())
  t.after(() => service.close())
  await service.resume()
  const timestamp = Date.UTC(2026, 10, 9, 12)
  for (let index = 0; index < 55; index++) {
    const text = index === 0 ? `${'x'.repeat(14000)}old-decision: keep Kotlin` : `Other message ${index}`
    const submission = await service.root.submit({ type: 'write', entry: {
      kind: 'test.history', model: [{ role: 'user', content: text, timestamp }],
    } }, BACKGROUND_CONTEXT)
    await submission.wait(BACKGROUND_CONTEXT)
  }
  const first = await service.history({ query: 'old-decision' })
  assert.deepEqual(first.entries, [])
  assert.ok(first.nextBeforeEntryId)
  const older = await service.history({ query: 'old-decision', beforeEntryId: first.nextBeforeEntryId })
  assert.equal(older.entries.length, 1)
  assert.equal(older.entries[0].timestamp, new Date(timestamp).toISOString())
  assert.ok(older.entries[0].text.includes('old-decision: keep Kotlin'))
  assert.equal(older.entries[0].truncated, true)
  assert.ok(older.entries[0].textOffset > 0)
  assert.equal(older.nextBeforeEntryId, null)
  await assert.rejects(service.history({ beforeEntryId: -1 }), { code: 'invalid' })
})

const permissionRequest = { options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }], toolCall: { title: 'Write a file' } }

async function settledInputs(state, count) {
  const receipts = []
  for (let index = 0; index < count; index++) {
    const receipt = await state.submit(`input-${index}`, `Message ${index}`)
    await state.settleInput(receipt.mainRunId, 'completed')
    receipts.push(receipt)
  }
  return receipts
}

async function nextTurn(state, requestId) {
  const { current } = await state.snapshot()
  if (current) await state.settleInput(current.id, 'completed')
  return state.submit(requestId, 'Work')
}

// Each run completes and is reported. A main turn admits at most eight runs, so a new turn starts every eight runs.
async function reportedRuns(state, count, prefix = 'run', permissions = () => 0) {
  const runs = []
  for (let index = 0; index < count; index++) {
    if (index % 8 === 0) await nextTurn(state, `${prefix}-turn-${index}`)
    const run = await state.admitChild(`${prefix}-${index}`, { cwd: '/workspace', prompt: `Task ${index}` })
    await state.transition(run.id, ['admitted'], { status: 'running', generation: 'process' })
    for (let request = 0; request < permissions(index); request++) await state.requestPermission(run.id, 'process', permissionRequest)
    await state.transition(run.id, ['running', 'approval'], { status: 'completed' })
    await state.readRun(run.id)
    runs.push(run)
  }
  return runs
}

// Each limit has its own code and a text with its number, so the main agent sees the real reason of a refusal.
test('a refusal for eight runs of one task, for eight unfinished runs and for 32 permissions of a run names that limit', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  assert.deepEqual([maxChildRunsPerTask, maxUnfinishedRuns, maxPermissionsPerRun], [8, 8, 32])
  await state.submit('main', 'Work')
  const runs = []
  for (let index = 0; index < 8; index++) runs.push(await state.admitChild(`run-${index}`, { cwd: '/workspace', prompt: `Task ${index}` }))
  // The limit of the task comes first, also when the unfinished runs are at their limit too.
  await assert.rejects(state.admitChild('ninth', { cwd: '/workspace', prompt: 'Task 8' }),
    { code: 'turnChildLimit', message: message('error.turnChildLimit', 8) })
  assert.match(message('error.turnChildLimit', 8), /^This turn started 8 child runs already, and one turn can start at most 8\./)
  await nextTurn(state, 'next')
  await assert.rejects(state.admitChild('unfinished', { cwd: '/workspace', prompt: 'Task 9' }),
    { code: 'unfinishedLimit', message: message('error.unfinishedLimit', 8) })
  assert.match(message('error.unfinishedLimit', 8), /^Megachat has 8 unfinished child tasks.*agents_cancel/)
  // An ended run frees a place.
  await state.transition(runs[0].id, ['admitted'], { status: 'running', generation: 'process' })
  for (let index = 0; index < 32; index++) await state.requestPermission(runs[0].id, 'process', permissionRequest)
  await assert.rejects(state.requestPermission(runs[0].id, 'process', permissionRequest),
    { code: 'permissionLimit', message: message('error.permissionLimit', 32) })
  assert.match(message('error.permissionLimit', 32), /^This child run made 32 permission requests already, and one run can make at most 32\./)
  await state.transition(runs[0].id, ['running', 'approval'], { status: 'completed' })
  assert.equal((await state.admitChild('unfinished', { cwd: '/workspace', prompt: 'Task 9' })).status, 'admitted')
})

test('the daemon admits input 1001 and drops the oldest settled inputs', { timeout: 30000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await settledInputs(state, 1000)
  const next = await state.submit('input-1000', 'Message 1000')
  assert.equal(next.status, 'running')
  const { inputs } = await state.snapshot()
  assert.equal(Object.keys(inputs).length, 501)
  for (let index = 500; index <= 1000; index++) assert.ok(inputs[`input-${index}`], `input-${index} stays`)
})

test('a repeated recent request ID returns its admission after a prune', { timeout: 30000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  const receipts = await settledInputs(state, 1000)
  await state.submit('input-1000', 'Message 1000')
  const repeated = await state.submit('input-999', 'Message 999')
  assert.equal(repeated.submissionId, receipts[999].submissionId)
  assert.equal(repeated.mainRunId, receipts[999].mainRunId)
  await assert.rejects(state.submit('input-999', 'Different'), { code: 'conflict' })
})

test('a dropped request ID is admitted as a new input', { timeout: 30000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  const receipts = await settledInputs(state, 1001)
  assert.equal((await state.snapshot()).inputs['input-0'], undefined)
  const again = await state.submit('input-0', 'Another message')
  assert.equal(again.status, 'running')
  assert.notEqual(again.submissionId, receipts[0].submissionId)
  assert.equal((await state.snapshot()).current.id, again.mainRunId)
})

test('the daemon admits child run 65 and drops the oldest reported runs', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  const runs = await reportedRuns(state, 64, 'run', index => index < 2 ? 1 : 0)
  assert.equal(Object.keys((await state.snapshot()).permissions).length, 2)
  await nextTurn(state, 'last-turn')
  const next = await state.admitChild('run-64', { cwd: '/workspace', prompt: 'Task 64' })
  const snapshot = await state.snapshot()
  assert.equal(snapshot.runs[next.id].status, 'admitted')
  const kept = Object.keys(snapshot.runs).filter(id => id !== next.id)
  assert.ok(kept.length <= 48, `${kept.length} old runs stay`)
  assert.deepEqual(kept, runs.slice(-kept.length).map(run => run.id))
  assert.ok(Object.values(snapshot.permissions).every(permission => snapshot.runs[permission.runId]))
  await assert.rejects(state.admitChild('dropped-follow-up', { cwd: '/workspace', childSessionId: runs[0].childSessionId, prompt: 'Again' }),
    { code: 'missing' })
})

test('a prune keeps a run that a continuation or the current report names', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('first-turn', 'Work')
  const continued = await state.admitChild('continued', { cwd: '/workspace', prompt: 'Continue me' })
  await state.transition(continued.id, ['admitted'], { status: 'ready', generation: 'process', providerSessionId: 'continued' })
  await state.transition(continued.id, ['ready'], { status: 'dispatched' })
  await state.transition(continued.id, ['dispatched'], { status: 'interrupted', error: message('error.interrupted') })
  await state.readRun(continued.id)
  const reported = await state.admitChild('reported', { cwd: '/workspace', prompt: 'Report me' })
  await state.transition(reported.id, ['admitted'], { status: 'completed' })
  const working = await state.admitChild('working', { cwd: '/workspace', prompt: 'Keep working' })
  await state.transition(working.id, ['admitted'], { status: 'ready', generation: 'process', providerSessionId: 'working' })
  await state.transition(working.id, ['ready'], { status: 'dispatched' })
  const filler = await reportedRuns(state, 60)
  let snapshot = await state.snapshot()
  assert.equal(Object.keys(snapshot.runs).length, 64)
  await state.settleInput(snapshot.current.id, 'completed')
  const report = await state.nextChildResults()
  assert.deepEqual(report.resultRunIds, [reported.id])
  await state.transition(working.id, ['dispatched'], { status: 'interrupted', error: message('error.interrupted') })
  snapshot = await state.snapshot()
  const continuation = snapshot.runs[snapshot.runs[continued.id].resumedBy]
  assert.equal(continuation.status, 'admitted')
  assert.ok(snapshot.runs[reported.id])
  assert.ok(snapshot.runs[snapshot.runs[working.id].resumedBy], 'The interrupted run gets its continuation')
  assert.equal(snapshot.runs[filler[0].id], undefined)
  assert.ok(Object.keys(snapshot.runs).length <= 49)
  assert.equal(await state.interruptAutomaticTurn(), true)
  assert.equal((await state.snapshot()).runs[reported.id].reported, false)
})

test('permission and proposal records are dropped oldest first, and a pending permission stays', { timeout: 30000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('first-turn', 'Work')
  const waiting = await state.admitChild('waiting', { cwd: '/workspace', prompt: 'Wait for permission' })
  await state.transition(waiting.id, ['admitted'], { status: 'running', generation: 'process' })
  const pending = await state.requestPermission(waiting.id, 'process', permissionRequest)
  await reportedRuns(state, 8, 'run', index => index === 7 ? 31 : 32)
  const before = Object.keys((await state.snapshot()).permissions)
  assert.equal(before.length, 256)
  const added = await state.requestPermission(waiting.id, 'process', permissionRequest)
  const after = await state.snapshot()
  assert.deepEqual(Object.keys(after.permissions), [pending, ...before.slice(-127), added])
  assert.equal(after.permissions[pending].status, 'pending')
  for (let index = 0; index < 2000; index++) await state.feedback(`feedback-${index}`, 'accepted')
  await state.feedback('feedback-2000', 'accepted')
  const decisions = Object.keys((await state.snapshot()).initiative.decisions)
  assert.equal(decisions.length, 1001)
  assert.equal(decisions[0], 'feedback-1000')
  assert.equal(decisions.at(-1), 'feedback-2000')
})

test('a state document without time fields prunes without an error', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-retention-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const database = join(directory, 'state.sqlite')
  let opened = await open(await openNodeSqliteStorage(database))
  // The records have the form that the code before retention wrote: no admittedAt, createdAt or decidedAt,
  // and no serviceSessions map. One record of each kind has its new time field, so it is the newest.
  await opened.state.change(state => {
    delete state.serviceSessions
    state.inputs.timed = { digest: 'timed', mainRunId: 'timed', submissionId: 1, status: 'completed', admittedAt: 1 }
    for (let index = 0; index < 999; index++) {
      state.inputs[`old-${index}`] = { digest: `old-${index}`, mainRunId: `old-${index}`, submissionId: index + 2, status: 'completed' }
    }
    for (let index = 0; index < 64; index++) {
      const id = `run-${index}`
      state.runs[id] = { id, childSessionId: id, mainRunId: 'old-0', agent: 'claude', requestId: id, digest: id, prompt: 'Old task',
        cwd: '/workspace', status: 'completed', providerSessionId: `provider-${index}`, serviceSession: index !== 0,
        generation: 'old', pid: null, output: '', truncated: false, updates: [{ sessionUpdate: 'tool_call' }], updateBytes: 30, cancelRequested: false,
        createdAt: index + 1, finishedAt: index + 1, closed: false, reported: true }
    }
    delete state.runs['run-1'].finishedAt
    state.permissions.timed = { id: 'timed', runId: 'run-63', generation: 'old', request: permissionRequest, status: 'answered', decision: 'yes', createdAt: 1 }
    for (let index = 0; index < 255; index++) {
      const id = `old-${index}`
      state.permissions[id] = { id, runId: 'run-63', generation: 'old', request: permissionRequest, status: 'answered', decision: 'yes' }
    }
    state.initiative.decisions.timed = { digest: 'timed', result: {}, decidedAt: 1 }
    for (let index = 0; index < 1999; index++) state.initiative.decisions[`old-${index}`] = { digest: `old-${index}`, result: {} }
  })
  await opened.harness.close(BACKGROUND_CONTEXT)
  opened = await open(await openNodeSqliteStorage(database))
  t.after(() => opened.harness.close(BACKGROUND_CONTEXT))
  const { state } = opened
  const addresses = Object.values((await state.snapshot()).serviceSessions).map(session => session.providerSessionId)
  assert.deepEqual(addresses, Array.from({ length: 63 }, (_, index) => `provider-${index + 1}`))
  // The open drops the stored updates of each run.
  assert.ok(Object.values((await state.snapshot()).runs).every(run => !('updates' in run) && !('updateBytes' in run)))
  await state.submit('new-input', 'Work')
  const run = await state.admitChild('new-run', { cwd: '/workspace', prompt: 'New task' })
  await state.transition(run.id, ['admitted'], { status: 'running', generation: 'process' })
  await state.requestPermission(run.id, 'process', permissionRequest)
  await state.feedback('new-decision', 'accepted')
  const snapshot = await state.snapshot()
  assert.equal(Object.keys(snapshot.inputs).length, 501)
  assert.ok(snapshot.inputs.timed && snapshot.inputs['old-500'] && snapshot.inputs['new-input'])
  assert.equal(snapshot.inputs['old-499'], undefined)
  assert.equal(Object.keys(snapshot.runs).length, 49)
  assert.equal(snapshot.runs['run-1'], undefined)
  assert.equal(snapshot.runs['run-15'], undefined)
  assert.ok(snapshot.runs['run-16'])
  assert.equal(Object.keys(snapshot.permissions).length, 129)
  assert.ok(snapshot.permissions.timed)
  assert.equal(Object.keys(snapshot.initiative.decisions).length, 1001)
  assert.ok(snapshot.initiative.decisions.timed && snapshot.initiative.decisions['new-decision'])
  assert.equal(snapshot.initiative.decisions['old-999'], undefined)
  assert.equal(Object.keys(snapshot.serviceSessions).length, 63)
})

test('at 5,000 delegated session addresses, the oldest go until 4,000 stay', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.change(doc => {
    for (let index = 0; index < 5000; index++) {
      doc.serviceSessions[`address-${index}`] = { agent: 'claude', cwd: '/workspace', providerSessionId: `old-${index}`, recordedAt: index + 1 }
    }
  })
  await state.submit('turn', 'Work')
  const run = await state.admitChild('child', { cwd: '/workspace', prompt: 'Work' })
  await state.transition(run.id, ['admitted'], { status: 'ready', generation: 'process', providerSessionId: 'new' })
  const sessions = Object.values((await state.snapshot()).serviceSessions)
  assert.equal(sessions.length, 4001)
  assert.equal(sessions[0].providerSessionId, 'old-1000')
  assert.deepEqual(sessions.at(-1), { agent: 'claude', cwd: '/workspace', providerSessionId: 'new', recordedAt: sessions.at(-1).recordedAt })
})

/** A run that sent its prompt to the provider session `provider`, as the run service leaves it. */
async function sentRun(state, requestId, prompt = 'Implement it') {
  const run = await state.admitChild(requestId, { cwd: '/workspace', prompt })
  await state.transition(run.id, ['admitted'], { status: 'ready', generation: 'process', providerSessionId: 'provider' })
  await state.transition(run.id, ['ready'], { status: 'dispatched' })
  return run
}

test('a steer message is recorded before the send, once for a repeated call, and at most 16 times for a task', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('main', 'Work')
  const run = await sentRun(state, 'tool')
  const args = { childSessionId: run.childSessionId, prompt: 'Use the link', mode: 'queue' }
  const before = Date.now()
  const steer = await state.steer('tool:1:steer', args)
  assert.equal(steer.runId, run.id)
  assert.deepEqual([steer.text, steer.mode, steer.delivery, steer.outcome], ['Use the link', 'queue', 'pending', null])
  assert.ok(steer.createdAt >= before)
  assert.equal((await state.steer('tool:1:steer', args)).id, steer.id)
  await assert.rejects(state.steer('tool:1:steer', { ...args, prompt: 'Another link' }), { code: 'conflict' })
  assert.equal((await state.snapshot()).runs[run.id].steers.length, 1)
  for (const invalid of [{ ...args, mode: 'later' }, { ...args, prompt: ' ' }])
    await assert.rejects(state.steer('invalid', invalid), { code: 'invalid' })
  // The error names the limit, so the main agent can split the message.
  await assert.rejects(state.steer('long', { ...args, prompt: 'x'.repeat(64001) }), { code: 'steerLength', message: /64,000 characters/ })
  await assert.rejects(state.steer('unknown', { ...args, childSessionId: 'unknown' }), { code: 'missing' })
  // A continuation counts the messages of the run that it continues.
  await state.transition(run.id, ['dispatched'], { status: 'interrupted', error: message('error.interrupted') })
  const next = (await state.snapshot()).runs[(await state.snapshot()).runs[run.id].resumedBy]
  assert.equal(next.steers.length, 1)
  for (let index = 1; index < maxSteers; index++) await state.steer(`tool:${index + 1}:steer`, args)
  await assert.rejects(state.steer('one-too-many', args), { code: 'steerLimit', message: message('error.steerLimit', maxSteers) })
  assert.match(message('error.steerLimit', maxSteers), /16 added messages/)
  await state.transition(next.id, ['admitted'], { status: 'cancelled' })
  await assert.rejects(state.steer('ended', args), { code: 'childIdle' })
  // Only a turn of the user can steer.
  const other = await sentRun(state, 'other')
  for (const kind of ['event', 'report']) {
    await state.change(value => { value.current.kind = kind })
    await assert.rejects(state.steer(`automatic-${kind}`, { ...args, childSessionId: other.childSessionId }), { code: 'steerEvent' })
  }
  await state.change(value => { value.current.kind = 'user'; value.current.cancelling = true })
  await assert.rejects(state.steer('cancelling', { ...args, childSessionId: other.childSessionId }), { code: 'inactive' })
})

test('a steer refuses a child task whose directory is no longer listed, as agents_send does', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('main', 'Work')
  const run = await sentRun(state, 'tool')
  // The directory leaves the list after the start of the child, as a known project that the user removes.
  await state.change(value => { value.workspaces.splice(value.workspaces.indexOf('/workspace'), 1) })
  await assert.rejects(state.steer('removed', { childSessionId: run.childSessionId, prompt: 'Use the link', mode: 'queue' }), { code: 'workspace' })
  await assert.rejects(state.directory('/workspace'), { code: 'workspace' })
  assert.equal((await state.snapshot()).runs[run.id].steers, undefined)
})

test('a steer of a queued run goes into its prompt, also after a restart', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('main', 'Work')
  const queued = await state.admitChild('queued', { cwd: '/workspace', prompt: 'Queued task' })
  const steer = await state.steer('queued-steer', { childSessionId: queued.childSessionId, prompt: 'Name it B', mode: 'interrupt' })
  assert.deepEqual([steer.delivery, steer.outcome], ['fallback', 'queued'])
  const run = (await state.snapshot()).runs[queued.id]
  assert.equal(run.status, 'admitted')
  assert.equal(run.prompt, 'Queued task')
  // A run that never sent its prompt sends it again after a restart, with the message.
  await state.transition(queued.id, ['admitted'], { status: 'launching', generation: 'process' })
  await state.recover()
  const snapshot = await state.snapshot()
  const next = snapshot.runs[snapshot.runs[queued.id].resumedBy]
  assert.equal(next.prompt, 'Queued task')
  assert.deepEqual(next.steers.map(item => [item.text, item.delivery, item.repeat]), [['Name it B', 'fallback', false]])
})

test('a restart carries each steer message that the provider session may not have into the continuation', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('main', 'Work')
  const run = await sentRun(state, 'tool')
  const args = { childSessionId: run.childSessionId, mode: 'queue' }
  const delivered = await state.steer('delivered', { ...args, prompt: 'Delivered' })
  const unsure = await state.steer('unsure', { ...args, prompt: 'Sent without an answer' })
  const waiting = await state.steer('waiting', { ...args, prompt: 'Not sent' })
  await state.updateSteer(run.id, 'process', delivered.id, { sentAt: Date.now(), delivery: 'delivered', outcome: 'injected' })
  await state.updateSteer(run.id, 'process', unsure.id, { sentAt: Date.now() })
  assert.equal(await state.updateSteer(run.id, 'other-process', waiting.id, { sentAt: Date.now() }), false)
  await state.recover()
  const snapshot = await state.snapshot()
  const old = snapshot.runs[run.id]
  const next = snapshot.runs[old.resumedBy]
  assert.equal(old.status, 'resumed')
  assert.equal(next.prompt, message('child.continue'))
  assert.equal(next.resumeAttempt, 1)
  assert.deepEqual(next.steers.map(item => [item.id, item.delivery, item.repeat]),
    [[delivered.id, 'fallback', true], [unsure.id, 'fallback', true], [waiting.id, 'fallback', false]])
  assert.deepEqual(old.steers.map(item => [item.carriedBy, item.outcome]), [[next.id, 'injected'], [next.id, 'restarted'], [next.id, 'restarted']])
  // The record of the steered run gives the outcome to the tool call.
  assert.equal(findSteer(snapshot, waiting.id).run.id, run.id)
})

test('a stop for a steer message continues the session at once, without an attempt, and with one report', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('main', 'Work')
  let run = await sentRun(state, 'tool')
  // Two failures use the automatic continuations.
  for (let attempt = 0; attempt < 2; attempt++) {
    await state.transition(run.id, ['dispatched'], { status: 'interrupted', error: message('error.interrupted') })
    run = (await state.snapshot()).runs[(await state.snapshot()).runs[run.id].resumedBy]
    await state.transition(run.id, ['admitted'], { status: 'ready', generation: 'process' })
    await state.transition(run.id, ['ready'], { status: 'dispatched' })
  }
  await state.appendUpdate(run.id, 'process', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial work. ' } })
  const steer = await state.steer('redirect', { childSessionId: run.childSessionId, prompt: 'Use the other branch', mode: 'interrupt' })
  assert.equal(await state.restartForSteer(run.id, 'other-process'), false)
  assert.equal(await state.restartForSteer(run.id, 'process'), true)
  assert.equal(findSteer(await state.snapshot(), steer.id).item.outcome, 'restarted')
  const before = Date.now()
  await state.transition(run.id, ['dispatched'], { status: 'interrupted', stopReason: 'cancelled' })
  const snapshot = await state.snapshot()
  const old = snapshot.runs[run.id]
  const next = snapshot.runs[old.resumedBy]
  assert.equal(old.reported, true)
  assert.equal(next.prompt, message('child.steer.restarted'))
  assert.equal(next.task, 'Implement it')
  assert.equal(next.resumeAttempt, 2)
  assert.equal(next.urgent, true)
  assert.ok(next.notBefore <= before + 1000)
  assert.equal(next.output, 'Partial work. ')
  assert.deepEqual(next.steers.map(item => item.text), ['Use the other branch'])
  // The two failures each give a report. The stop for the message gives none: the continuation reports the task.
  await state.settleInput(snapshot.current.id, 'completed')
  assert.ok(!(await state.nextChildResults()).resultRunIds.includes(old.id))
})

test('a completed run with a steer message that it did not handle gets a follow-up in the same session', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('main', 'Work')
  const handled = await sentRun(state, 'handled')
  const injected = await state.steer('injected', { childSessionId: handled.childSessionId, prompt: 'Handled', mode: 'queue' })
  await state.updateSteer(handled.id, 'process', injected.id, { sentAt: Date.now(), delivery: 'delivered', outcome: 'injected' })
  await state.transition(handled.id, ['dispatched'], { status: 'completed', stopReason: 'end_turn' })
  assert.equal((await state.snapshot()).runs[handled.id].status, 'completed')
  const late = await sentRun(state, 'late')
  await state.appendUpdate(late.id, 'process', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Result. ' } })
  const after = await state.steer('after', { childSessionId: late.childSessionId, prompt: 'Too late', mode: 'queue' })
  await state.transition(late.id, ['dispatched'], { status: 'completed', stopReason: 'end_turn' })
  const snapshot = await state.snapshot()
  const next = snapshot.runs[snapshot.runs[late.id].resumedBy]
  assert.equal(snapshot.runs[late.id].status, 'resumed')
  assert.equal(snapshot.runs[late.id].reported, true)
  assert.equal(next.prompt, message('child.steer.followUp'))
  assert.equal(next.providerSessionId, 'provider')
  assert.equal(next.output, 'Result. ')
  assert.equal(findSteer(snapshot, after.id).item.outcome, 'followUp')
  assert.deepEqual(next.steers.map(item => [item.text, item.repeat]), [['Too late', false]])
})

test('a message that goes in a follow-up gets the outcome followUp, also after the answer injected or a stop request', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('main', 'Work')
  // The agent took the message, and the turn ended without work after it: the run service makes it pending again.
  const dropped = await sentRun(state, 'dropped')
  const injected = await state.steer('injected', { childSessionId: dropped.childSessionId, prompt: 'Also test it', mode: 'queue' })
  await state.updateSteer(dropped.id, 'process', injected.id, { sentAt: Date.now(), delivery: 'delivered', outcome: 'injected' })
  await state.updateSteer(dropped.id, 'process', injected.id, { delivery: 'pending' })
  await state.transition(dropped.id, ['dispatched'], { status: 'completed', stopReason: 'end_turn' })
  // The stop for the message came after the end of the turn.
  const late = await sentRun(state, 'late')
  const stopped = await state.steer('stopped', { childSessionId: late.childSessionId, prompt: 'Use the other branch', mode: 'interrupt' })
  assert.equal(await state.restartForSteer(late.id, 'process'), true)
  await state.transition(late.id, ['dispatched'], { status: 'completed', stopReason: 'end_turn' })
  const snapshot = await state.snapshot()
  for (const [run, steer] of [[dropped, injected], [late, stopped]]) {
    const next = snapshot.runs[snapshot.runs[run.id].resumedBy]
    assert.equal(next.prompt, message('child.steer.followUp'))
    assert.equal(findSteer(snapshot, steer.id).item.outcome, 'followUp')
    assert.equal(next.steers[0].outcome, 'followUp')
  }
})

test('the one report of a steered task gives the task and the title of its first run', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('main', 'Work')
  const run = await state.admitChild('tool', { cwd: '/workspace', prompt: 'Implement it', title: 'Implement the parser' })
  const send = async (id, generation) => {
    await state.transition(id, ['admitted'], { status: 'ready', generation, providerSessionId: 'provider' })
    await state.transition(id, ['ready'], { status: 'dispatched' })
  }
  await send(run.id, 'first')
  // A stop for a message, then a follow-up for a message that came after the end of the turn.
  await state.steer('redirect', { childSessionId: run.childSessionId, prompt: 'Use the other branch', mode: 'interrupt' })
  await state.restartForSteer(run.id, 'first')
  await state.transition(run.id, ['dispatched'], { status: 'interrupted', stopReason: 'cancelled' })
  const restarted = (await state.snapshot()).runs[(await state.snapshot()).runs[run.id].resumedBy]
  await send(restarted.id, 'second')
  await state.steer('late', { childSessionId: run.childSessionId, prompt: 'One more file', mode: 'queue' })
  await state.transition(restarted.id, ['dispatched'], { status: 'completed', stopReason: 'end_turn' })
  const last = (await state.snapshot()).runs[(await state.snapshot()).runs[restarted.id].resumedBy]
  assert.equal(last.title, 'Implement the parser')
  await send(last.id, 'third')
  await state.transition(last.id, ['dispatched'], { status: 'completed', stopReason: 'end_turn' })
  await state.settleInput((await state.snapshot()).current.id, 'completed')
  assert.deepEqual((await state.nextChildResults()).resultRunIds, [last.id])
  const event = (await state.root.entries({ order: 'descending' }, 50, undefined, BACKGROUND_CONTEXT)).items
    .find(entry => entry.kind === 'air.megachat.event')
  assert.deepEqual(event.data.results.map(result => [result.runId, result.prompt, result.title]), [[last.id, 'Implement it', 'Implement the parser']])
})

test('the prune of a run removes its steer messages', { timeout: 10000 }, async t => {
  const { harness, state } = await open()
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  await state.submit('first-turn', 'Work')
  const steered = await state.admitChild('steered', { cwd: '/workspace', prompt: 'Steer me' })
  await state.transition(steered.id, ['admitted'], { status: 'running', generation: 'process' })
  const steer = await state.steer('steer', { childSessionId: steered.childSessionId, prompt: 'Added', mode: 'queue' })
  await state.transition(steered.id, ['running'], { status: 'completed' })
  await state.readRun(steered.id)
  await reportedRuns(state, 63)
  await nextTurn(state, 'last-turn')
  await state.admitChild('run-64', { cwd: '/workspace', prompt: 'Task 64' })
  const snapshot = await state.snapshot()
  assert.equal(snapshot.runs[steered.id], undefined)
  assert.equal(findSteer(snapshot, steer.id), null)
})
