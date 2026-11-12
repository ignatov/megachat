import { randomUUID } from 'node:crypto'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { ChildSlot } from './ChildSlot.mjs'
import { MegachatDoc } from './MegachatState.mjs'
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

/**
 * Executes the admitted pi runs in the daemon process, as `AcpRunService` executes the Claude and Codex runs. A pi run
 * goes through the same states, so the reports, the limits and the prune rules stay the same. Each child session is an
 * ownerless conversation of the harness of the main agent, and the ID of that conversation is the provider session ID of
 * its runs. [agent] gives the choices of the child conversation for the directory of a run. [slot] is the one place for
 * a child that this service shares with the ACP run service.
 *
 * A daemon stop leaves a dispatched run as it is: Pi Durable continues its conversation after the restart, and the next
 * service follows it to its end.
 */
export class PiRunService {
  constructor(state, harness, { agent, slot = new ChildSlot(), deadlineMs = 1800000 } = {}) {
    this.state = state
    this.harness = harness
    this.agent = agent
    this.slot = slot
    this.deadlineMs = deadlineMs
    this.active = new Map()
    this.stopping = false
    this.closing = false
  }

  async start() {
    this.watch = await this.state.watch()
    this.unsubscribe = this.slot.subscribe(() => { if (!this.stopping) this.observe(this.watch.value) })
    const snapshot = this.watch.value
    for (const run of Object.values(snapshot.runs)) {
      if (run.agent === 'pi' && run.status === 'dispatched' && this.slot.resume(snapshot, run)) this.begin(run)
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
      if (run.status === 'admitted' && !this.stopping && this.slot.take(snapshot, run, now)) this.begin(run)
      const work = this.active.get(run.id)
      if (work?.cancel && run.cancelRequested && !work.cancellationSent) {
        work.cancellationSent = true
        work.cancel()
      }
    }
  }

  begin(run) {
    const work = { cancel: null, cancellationSent: false, promise: null, lifetime: new AbortController() }
    this.active.set(run.id, work)
    work.promise = this.execute(run, work).finally(() => {
      this.active.delete(run.id)
      this.slot.release(run.id)
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
        // A dispatched run of the last daemon: a new generation, and its output from the start of its run again.
        if (!await this.state.transition(run.id, ['dispatched'], { generation, output: '', truncated: false })) return
        conversation = await this.harness.conversation(Number(run.providerSessionId), context)
        requireCondition(conversation, 'missing')
      }
      else {
        const deadlineAt = Date.now() + this.deadlineMs
        if (!await this.state.transition(run.id, ['admitted'], { status: 'launching', generation, deadlineAt })) return
        run = { ...run, deadlineAt }
        const agent = await this.agent(run.cwd)
        if (run.providerSessionId) {
          conversation = await this.harness.conversation(Number(run.providerSessionId), context)
          requireCondition(conversation, 'missing')
          await conversation.configure(agent, context)
        }
        else conversation = await this.create(run, agent)
        if (!await this.state.transition(run.id, ['launching'], { status: 'ready' })) return
        work.cancel = () => conversation.abort(context).catch(() => {})
        if ((await this.state.snapshot()).runs[run.id].cancelRequested) {
          await this.state.transition(run.id, ['ready'], { status: 'cancelled' })
          return
        }
        baseline = (await conversation.entries({ order: 'descending' }, 1, undefined, context)).items[0]?.id ?? 0
        submissionId = await this.dispatch(run, generation, conversation, baseline)
        if (submissionId === null) {
          await this.state.transition(run.id, ['ready'], { status: 'cancelled' })
          return
        }
        dispatched = true
      }
      work.cancel = () => conversation.abort(context).catch(() => {})
      if ((await this.state.snapshot()).runs[run.id].cancelRequested) work.cancel()
      timer = setTimeout(() => {
        limited = true
        conversation.abort(context).catch(() => {})
      }, Math.max(0, (run.deadlineAt ?? Date.now() + this.deadlineMs) - Date.now()))
      const settled = await this.follow(run, work, generation, conversation, submissionId, baseline)
      const current = (await this.state.snapshot()).runs[run.id]
      const reason = settled.status === 'done' ? 'end_turn' : String(settled.reason ?? 'unknown').slice(0, 64)
      const status = current.cancelRequested ? 'cancelled' : settled.status === 'done' ? 'completed'
        : limited || repeatableReasons.has(reason) ? 'interrupted' : 'failed'
      await this.state.transition(run.id, ['dispatched'], { status, stopReason: reason,
        ...(status === 'interrupted' ? { error: message(limited ? 'error.limit' : 'error.interrupted'), autoResume: !limited } : {}),
        ...(status === 'failed' ? { error: message('error.pi.stopped', reason) } : {}) })
    }
    catch (error) {
      // After a daemon stop, Pi Durable continues a dispatched run in the next daemon.
      if (this.closing && dispatched) return
      const current = (await this.state.snapshot()).runs[run.id]
      if (!this.closing && !current.cancelRequested) logFailure('log.child', error, run.id)
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
  dispatch(run, generation, conversation, baseline) {
    return this.state.change(async (state, tx) => {
      const current = state.runs[run.id]
      requireCondition(current.status === 'ready' && current.generation === generation, 'stale')
      if (current.cancelRequested) return null
      const content = run.task === undefined ? run.prompt : `${run.prompt}\n\n${message('child.task')}\n${run.task}`
      const submissionId = await conversation.submit(tx, { type: 'input', content, requestId: `run:${run.id}` })
      Object.assign(current, { status: 'dispatched', dispatched: true, submissionId, entryBaseline: baseline })
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
    let wrote = false
    let updates = Promise.resolve()
    const copy = () => {
      updates = updates.then(async () => {
        for (let cursor, page; !page || page.next; cursor = page.next) {
          page = await conversation.entries({ order: 'ascending', minEntryId: seen + 1 }, 50, cursor, context)
          for (const entry of page.items) {
            seen = Math.max(seen, entry.id)
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
      const settled = await submission.wait(withAbortSignal(work.lifetime.signal, context))
      await copy()
      return settled
    }
    finally { await watch.stop() }
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
