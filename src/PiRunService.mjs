import { randomUUID } from 'node:crypto'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { ConversationBusy, ConversationIdle } from '@earendil-works/pi-durable'
import { steerBlock } from './AcpRunService.mjs'
import { ChildPool } from './ChildPool.mjs'
import { maxAutomaticResumes, MegachatDoc, terminalStates } from './MegachatState.mjs'
import { logFailure, MegachatError, message, requireCondition } from './messages.mjs'
import { PiChildDoc } from './PiChild.mjs'

const context = BACKGROUND_CONTEXT
/** The reasons of Pi Durable for a run without an answer that a continuation can repair: a model error and a crash. */
const repeatableReasons = new Set(['model_error', 'interrupted'])

/** The text that the child wrote in one entry of its conversation, or an empty text. */
function assistantText(entry) {
  return (entry.model ?? []).filter(model => model.role === 'assistant')
    .flatMap(model => model.content.filter(block => block.type === 'text').map(block => block.text)).join('\n').trim()
}

/** Gives the texts and the tool calls of the child in one entry of its conversation to [transcript], in their order. */
function transcribe(transcript, entry) {
  for (const model of entry.model ?? []) {
    if (model.role !== 'assistant') continue
    for (const block of model.content) {
      if (block.type === 'text' && block.text.trim()) transcript.text(block.text)
      // The tool `read` has one argument, the path. Another tool shows its arguments as JSON.
      if (block.type === 'toolCall') transcript.tool(block.name, block.arguments?.path ?? JSON.stringify(block.arguments ?? {}))
    }
  }
}

/**
 * Executes the admitted pi runs in the daemon process, as `AcpRunService` executes the Claude and Codex runs. A pi run
 * goes through the same states, so the reports, the limits and the prune rules stay the same. Each child session is an
 * ownerless conversation of the harness of the main agent, and the ID of that conversation is the provider session ID of
 * its runs. [agent] gives the choices of the child conversation for the directory of a run. [pool] holds the places for
 * the children, and this service shares it with the ACP run service.
 *
 * A daemon stop leaves a dispatched run as it is: Pi Durable continues its conversation after the restart, and the next
 * service follows it to its end.
 *
 * The tool `agents_steer` records a message in the state, and this service gives it to the conversation of the child,
 * as `AcpRunService` gives it to its agent. The submission of a message and the record of its delivery are one commit
 * in the same storage, so a message arrives one time, also after a restart.
 */
export class PiRunService {
  constructor(state, harness, { agent, pool = new ChildPool(), deadlineMs = 1800000, transcripts } = {}) {
    this.state = state
    // The transcripts of the runs (`ChildTranscripts`). A test without it writes none.
    this.transcripts = transcripts
    this.harness = harness
    this.agent = agent
    this.pool = pool
    this.deadlineMs = deadlineMs
    this.active = new Map()
    this.stopping = false
    this.closing = false
  }

  async start() {
    this.watch = await this.state.watch()
    this.unsubscribe = this.pool.subscribe(() => { if (!this.stopping) this.observe(this.watch.value) })
    const snapshot = this.watch.value
    for (const run of Object.values(snapshot.runs)) {
      if (run.agent === 'pi' && run.status === 'dispatched' && this.pool.resume(run)) this.begin(run)
    }
    this.observe(snapshot)
    this.watch.start(call => { if (call.kind === 'value') this.observe(call.value) })
  }

  observe(snapshot) {
    const now = Date.now()
    for (const run of Object.values(snapshot.runs)) {
      if (run.agent !== 'pi') continue
      if (run.status === 'admitted' && (run.notBefore ?? 0) > now) {
        if (!this.stopping) this.wakeAt(run.notBefore)
        continue
      }
      if (run.status === 'admitted' && !this.stopping && this.pool.take(snapshot, run, now)) this.begin(run)
      const work = this.active.get(run.id)
      if (work?.cancel && run.cancelRequested && !work.cancellationSent) {
        work.cancellationSent = true
        work.cancel()
      }
      if (work?.deliver && run.steers?.some(item => item.delivery === 'pending' && !work.steered.has(item.id))) work.deliver()
    }
  }

  begin(run) {
    const work = { cancel: null, cancellationSent: false, promise: null, lifetime: new AbortController(),
      steered: new Set(), deliver: null, delivering: null, ended: false, withdrawn: 0 }
    this.active.set(run.id, work)
    work.promise = this.execute(run, work).finally(() => {
      this.active.delete(run.id)
      this.pool.release(run.id)
      if (!this.stopping) this.observe(this.watch.value)
    })
    work.promise.catch(error => {
      // The state did not take the end of the run. A new run can then start a second child on the same work.
      if (!this.closing) logFailure('log.children', error)
      this.stopping = true
    })
  }

  wakeAt(time) {
    if (this.wake && this.wake.time <= time) return
    clearTimeout(this.wake?.timer)
    const timer = setTimeout(() => {
      this.wake = null
      if (!this.stopping) this.observe(this.watch.value)
    }, Math.max(0, time - Date.now()) + 1)
    this.wake = { time, timer }
  }

  /**
   * Creates the conversation of a new child session. The same commit records its ID in the run and marks it as a child,
   * so a restart cannot leave a conversation that no run names, or a child conversation without its limit.
   */
  async create(run, agent) {
    const created = await this.harness.createConversation({ ownership: { kind: 'ownerless' }, agent, init: async (tx, id) => {
      const state = await tx.doc(MegachatDoc, this.state.root.id)
      state.runs[run.id].providerSessionId = String(id)
      Object.assign(await tx.doc(PiChildDoc, id), { root: run.cwd })
    } }, context)
    return created
  }

  async execute(run, work) {
    const generation = randomUUID()
    let conversation
    let timer
    let limited = false
    let dispatched = run.status === 'dispatched'
    try {
      let submissionId = run.submissionId
      let baseline = run.entryBaseline ?? 0
      if (dispatched) {
        // A dispatched run of the last daemon: a new generation, and its output from the start of its run again. A
        // continuation for a message of the user starts with the output of the run before it.
        if (!await this.state.transition(run.id, ['dispatched'], { generation, output: run.carriedOutput ?? '',
          truncated: run.carriedTruncated ?? false })) return
        work.transcript = this.transcripts?.begin(run, { again: true })
        conversation = await this.harness.conversation(Number(run.providerSessionId), context)
        requireCondition(conversation, 'missing')
      }
      else {
        const deadlineAt = Date.now() + this.deadlineMs
        if (!await this.state.transition(run.id, ['admitted'], { status: 'launching', generation, deadlineAt, startedAt: Date.now() })) return
        work.transcript = this.transcripts?.begin(run)
        run = { ...run, deadlineAt }
        // A step before the dispatch can wait on the file system. A cancel, the deadline and a daemon stop end the wait,
        // and the run ends as for an error. The dispatch is one commit, so it gets no such end.
        const launch = new AbortController()
        const stopped = new Promise((_, reject) => launch.signal.addEventListener('abort',
          () => reject(limited ? new MegachatError('limit') : new Error('stopped')), { once: true }))
        stopped.catch(() => {})
        const step = promise => Promise.race([promise, stopped])
        work.lifetime.signal.addEventListener('abort', () => launch.abort(), { once: true })
        work.cancel = () => launch.abort()
        timer = setTimeout(() => {
          limited = true
          launch.abort()
        }, this.deadlineMs)
        const agent = await step(this.agent(run.cwd))
        if (run.providerSessionId) {
          conversation = await step(this.harness.conversation(Number(run.providerSessionId), context))
          requireCondition(conversation, 'missing')
          await step(conversation.configure(agent, context))
        }
        else conversation = await step(this.create(run, agent))
        if (!await this.state.transition(run.id, ['launching'], { status: 'ready' })) return
        work.cancel = () => {
          launch.abort()
          return conversation.abort(context).catch(() => {})
        }
        if ((await this.state.snapshot()).runs[run.id].cancelRequested) {
          await this.state.transition(run.id, ['ready'], { status: 'cancelled' })
          return
        }
        baseline = (await step(conversation.entries({ order: 'descending' }, 1, undefined, context))).items[0]?.id ?? 0
        clearTimeout(timer)
        submissionId = await this.dispatch(run, generation, conversation, baseline, work)
        if (submissionId === null) {
          await this.state.transition(run.id, ['ready'], { status: 'cancelled' })
          return
        }
        dispatched = true
      }
      work.cancel = () => conversation.abort(context).catch(() => {})
      if ((await this.state.snapshot()).runs[run.id].cancelRequested) work.cancel()
      work.deliver = () => this.deliverSteers(run.id, generation, work, conversation)
      work.deliver()
      timer = setTimeout(() => {
        limited = true
        conversation.abort(context).catch(() => {})
      }, Math.max(0, (run.deadlineAt ?? Date.now() + this.deadlineMs) - Date.now()))
      const settled = await this.follow(run, work, generation, conversation, submissionId, baseline)
      const current = (await this.state.snapshot()).runs[run.id]
      const reason = settled.status === 'done' ? 'end_turn' : String(settled.reason ?? 'unknown').slice(0, 64)
      // A stop for a message of the user is an interruption. Its continuation holds the message.
      const restarted = current.steerRestart && !limited
      const status = current.cancelRequested ? 'cancelled' : settled.status === 'done' ? 'completed'
        : restarted || limited || repeatableReasons.has(reason) ? 'interrupted' : 'failed'
      const error = status === 'failed' ? message('error.pi.stopped', reason)
        : status === 'interrupted' && !restarted ? message(limited ? 'error.limit' : 'error.interrupted') : undefined
      // A continuation carries a withdrawn message. Without one, the report tells the main agent to send it again.
      const continued = restarted || status === 'interrupted' && !limited && (current.resumeAttempt ?? 0) < maxAutomaticResumes
      const unhandled = error !== undefined && !continued && work.withdrawn > 0
      await this.state.transition(run.id, ['dispatched'], { status, stopReason: reason,
        ...(error === undefined ? {} : { error: unhandled ? `${error} ${message('error.pi.unhandledSteers', work.withdrawn)}` : error }),
        ...(status === 'interrupted' && !restarted ? { autoResume: !limited } : {}) })
    }
    catch (error) {
      work.ended = true
      await work.delivering
      // After a daemon stop, Pi Durable continues a dispatched run in the next daemon.
      if (this.closing && dispatched) return
      const current = (await this.state.snapshot()).runs[run.id]
      if (!this.closing && !limited && !current.cancelRequested && !current.steerRestart) logFailure('log.child', error, run.id)
      // A continuation must not meet the old run of the same conversation.
      if (dispatched) await conversation?.abort(context).catch(() => {})
      await this.state.transition(run.id, ['launching', 'ready', 'dispatched'], {
        status: current.cancelRequested ? 'cancelled' : 'interrupted',
        error: current.cancelRequested ? null : error instanceof MegachatError ? error.message : message('error.interrupted'),
        autoResume: !(error instanceof MegachatError),
        ...(this.closing ? { plannedStop: true } : {}),
      })
    }
    finally {
      work.lifetime.abort()
      clearTimeout(timer)
    }
  }

  /**
   * Submits the prompt of [run] to its conversation in the commit that makes the run dispatched. So a restart finds
   * either both or neither, and the request ID of the run stops a second submission. Gives `null` for a cancelled run.
   */
  dispatch(run, generation, conversation, baseline, work) {
    return this.state.change(async (state, tx) => {
      const current = state.runs[run.id]
      requireCondition(current.status === 'ready' && current.generation === generation, 'stale')
      if (current.cancelRequested) return null
      // A message of the user from before the dispatch goes in the prompt, as a block after the task.
      const added = (current.steers ?? []).filter(item => item.delivery === 'fallback')
      const task = run.task === undefined ? run.prompt : `${run.prompt}\n\n${message('child.task')}\n${run.task}`
      const content = [task, ...(added.length ? [steerBlock(added)] : [])].join('\n\n')
      // The commit can run this function again, so the transcript gets the prompt after the commit.
      work.prompt = { task, added }
      const submissionId = await conversation.submit(tx, { type: 'input', content, requestId: `run:${run.id}` })
      Object.assign(current, { status: 'dispatched', dispatched: true, submissionId, entryBaseline: baseline,
        // A continuation for a message of the user starts with the output of the run before it. A restart needs it again.
        ...(current.output ? { carriedOutput: current.output, carriedTruncated: current.truncated } : {}) })
      return submissionId
    }).then(submissionId => {
      if (submissionId !== null) work.transcript?.prompt(work.prompt.task, work.prompt.added)
      return submissionId
    })
  }

  /**
   * Copies the text of each new answer of the child into the output of the run, as the ACP path copies each
   * `agent_message_chunk`, until the submission of the run settles. The watch of the conversation only wakes the copy:
   * the copy reads the entries after the last one that it saw, so a full window of the watch loses no entry.
   */
  async follow(run, work, generation, conversation, submissionId, baseline) {
    let seen = baseline
    let wrote = Boolean((await this.state.snapshot()).runs[run.id].output)
    let updates = Promise.resolve()
    const copy = () => {
      updates = updates.then(async () => {
        for (let cursor, page; !page || page.next; cursor = page.next) {
          page = await conversation.entries({ order: 'ascending', minEntryId: seen + 1 }, 50, cursor, context)
          for (const entry of page.items) {
            seen = Math.max(seen, entry.id)
            if (work.transcript) transcribe(work.transcript, entry)
            const text = assistantText(entry)
            if (!text) continue
            await this.state.appendUpdate(run.id, generation, { sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: wrote ? `\n\n${text}` : text } })
            wrote = true
          }
        }
      })
      return updates
    }
    const watch = await conversation.watch(context, { min: 1, max: 2 })
    try {
      watch.start(call => { if (call.kind === 'value' && (call.value.entries.at(-1)?.id ?? 0) > seen) copy().catch(() => {}) })
      const submission = await this.harness.submission(submissionId, context)
      requireCondition(submission, 'missing')
      const signal = withAbortSignal(work.lifetime.signal, context)
      let settled = await submission.wait(signal)
      // A message that the conversation took during the turn can run after the answer. The run ends after it, and a
      // message that came later waits for a follow-up.
      work.ended = true
      await work.delivering
      for (const item of (await this.state.snapshot()).runs[run.id].steers ?? []) {
        if (item.delivery !== 'delivered' || item.submissionId === undefined) continue
        const steering = await this.harness.submission(item.submissionId, context)
        // After a failed turn, Pi Durable keeps a message that it did not place in the inbox until the next input. The
        // run withdraws it, so a continuation carries it, or the report tells that the child did not get it.
        if (settled.status !== 'done' && await steering?.abort(context) === 'aborted') {
          work.withdrawn += 1
          continue
        }
        const steered = await steering?.wait(signal)
        if (steered && steered.status !== 'done') settled = steered
      }
      await copy()
      return settled
    }
    finally { await watch.stop() }
  }

  /**
   * Gives the waiting messages of the user to the conversation, one at a time. A call during a give looks again at its
   * end. The last look at `again` and the clear of `delivering` are one synchronous step, so a later call starts a new
   * give, as in `AcpRunService.deliverSteers`.
   */
  deliverSteers(runId, generation, work, conversation) {
    if (work.delivering) {
      work.again = true
      return work.delivering
    }
    work.delivering = (async () => {
      try {
        do {
          work.again = false
          await this.sendSteers(runId, generation, work, conversation)
        } while (work.again && !work.ended)
      }
      finally { work.delivering = null }
    })().catch(error => {
      if (!this.closing) logFailure('log.child', error, runId)
    })
    return work.delivering
  }

  /**
   * Gives each waiting message of the user to the turn of the child. The mode `queue` submits it with `whenBusy: steer`:
   * Pi Durable places it after the current tool round, and the outcome is `injected`. The request ID of the tool call
   * stops a second submission, and the same commit marks the message delivered. `whenIdle: reject` refuses it when the
   * turn ended first: the message waits, and the end of the run gives a follow-up in the same conversation. The mode
   * `interrupt`, and each other refusal, give the fallback: an abort of the turn, then a continuation with the message.
   */
  async sendSteers(runId, generation, work, conversation) {
    for (;;) {
      const run = (await this.state.snapshot()).runs[runId]
      if (work.ended || run.generation !== generation || run.steerRestart || run.cancelRequested || terminalStates.has(run.status)) return
      const item = run.steers?.find(value => value.delivery === 'pending' && !work.steered.has(value.id))
      if (!item) return
      work.steered.add(item.id)
      let given = false
      if (item.mode === 'queue') {
        given = await this.state.change(async (state, tx) => {
          const current = state.runs[runId]
          const stored = current?.steers?.find(value => value.id === item.id)
          if (!stored || stored.delivery !== 'pending' || current.generation !== generation || terminalStates.has(current.status)) return 'gone'
          let submissionId
          try {
            submissionId = await conversation.submit(tx, { type: 'input', content: `${message('child.steer')}\n\n${item.text}`,
              requestId: `steer:${item.requestId}`, whenBusy: 'steer', whenIdle: 'reject' })
          }
          catch (error) {
            if (error instanceof ConversationIdle) return 'idle'
            if (error instanceof ConversationBusy) return 'refused'
            throw error
          }
          Object.assign(stored, { delivery: 'delivered', outcome: 'injected', sentAt: Date.now(), submissionId })
          return 'injected'
        })
        if (given === 'injected') work.transcript?.steer(item.text)
        // The turn ended first: the message waits for the end of the run, which gives a follow-up.
        if (given === 'idle' || given === 'gone' || given === 'injected') continue
      }
      if (await this.state.restartForSteer(runId, generation)) await conversation.abort(context).catch(() => {})
      return
    }
  }

  async close() {
    this.closing = true
    this.stopping = true
    clearTimeout(this.wake?.timer)
    this.unsubscribe?.()
    await this.watch?.stop()
    for (const work of this.active.values()) work.lifetime.abort()
    await Promise.allSettled([...this.active.values()].map(work => work.promise))
  }
}
