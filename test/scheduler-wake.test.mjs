import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { fakeModels, MAIN } from './parallel-models.mjs'

/** The highest count of the delays that the test tries. Pi Durable 1.5.0 loses the wake-up at one count below it. */
const MAX_TICKS = 48
/** A turn of a scan that has no end in this time hangs. A sound turn ends in some milliseconds. */
const HANG_MS = 1500

/**
 * The storage of the test. The end of each storage commit that ends a tool task comes [ticks] microtasks late. So the
 * publication of the end of a tool call moves through the work of the scheduler in steps of one microtask, and one
 * count puts it into the gap of the reservation pass (see `wakeFinishedWaits`).
 */
function lateToolEnds(ticks) {
  const storage = new MemoryStorage()
  return new Proxy(storage, { get(target, name) {
    const value = Reflect.get(target, name)
    if (name !== 'commit') return typeof value === 'function' ? value.bind(target) : value
    return async (batches, ...rest) => {
      const result = await target.commit(batches, ...rest)
      const text = JSON.stringify(batches)
      if (text.includes('"pi.tool"') && text.includes('"terminal"')) for (let index = 0; index < ticks; index++) await null
      return result
    }
  } })
}

/**
 * One turn of the user in which the main agent starts three tasks in one reply, as in issue #25. Gives `ended` or
 * `hang`, whether the guard wrote a record, and the tool results that the second model request got.
 */
async function turn(directory, ticks, schedulerWake) {
  const projects = ['a', 'b', 'c'].map(name => join(directory, name))
  const spawn = fauxAssistantMessage(projects.map((cwd, index) => fauxToolCall('agents_spawn', { cwd, prompt: `Task ${index}.` })), { stopReason: 'toolUse' })
  const { models, requests } = fakeModels([spawn, fauxAssistantMessage('Started.')], [])
  const lines = []
  const write = process.stderr.write
  process.stderr.write = chunk => { lines.push(String(chunk)); return true }
  const service = await PiMegachatService.open(lateToolEnds(ticks), models, undefined, {},
    { settingsPath: join(directory, 'settings.json'), spendPath: join(directory, `spend-${ticks}.json`), keepAlive: { enabled: false },
      environment: {}, schedulerWake })
  try {
    for (const cwd of projects) await service.state.addWorkspace(cwd)
    await service.resume()
    const receipt = await service.submit(`input-${ticks}`, 'Start three tasks.')
    let timer
    const end = await Promise.race([service.waiters.get(receipt.mainRunId).then(() => 'ended'),
      new Promise(resolve => { timer = setTimeout(resolve, HANG_MS, 'hang') })])
    clearTimeout(timer)
    const last = requests.at(-1)?.messages ?? ''
    return { end, woke: lines.some(line => line.includes(message('log.schedulerWake.write', '\u0000').split('\u0000')[1])),
      results: (last.match(/"role":"toolResult"/g) ?? []).length, current: (await service.state.snapshot()).current }
  }
  finally {
    await service.close()
    process.stderr.write = write
  }
}

async function scan(t, schedulerWake) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-wake-')))
  t.after(() => rm(directory, { force: true, recursive: true }))
  for (const name of ['a', 'b', 'c']) await mkdir(join(directory, name))
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values: { 'coordinator.model': MAIN } }), { mode: 0o600 })
  const turns = []
  for (let ticks = 0; ticks <= MAX_TICKS; ticks++) turns.push({ ticks, ...await turn(directory, ticks, schedulerWake) })
  return turns
}

test('a turn with three tool calls in one reply ends also when the scheduler of Pi Durable loses the wake-up of its step', { timeout: 120000 }, async t => {
  // Without the guard, Pi Durable 1.5.0 keeps the step waiting for one delay. When this assertion fails, a new Pi Durable
  // has no such defect at these delays, and the guard can go after a check of the new scheduler.
  const unguarded = await scan(t, false)
  const hung = unguarded.filter(item => item.end === 'hang').map(item => item.ticks)
  assert.ok(hung.length > 0, 'Pi Durable lost no wake-up')
  for (const item of unguarded.filter(item => item.end === 'hang')) assert.ok(item.current, 'the hung turn is still current')
  // With the guard, each turn ends, and the main agent gets the three tool results in its next request.
  const guarded = await scan(t, true)
  assert.deepEqual(guarded.filter(item => item.end !== 'ended').map(item => item.ticks), [])
  for (const item of guarded) {
    assert.equal(item.results, 3, `the tool results of the delay ${item.ticks}`)
    assert.equal(item.current, null)
  }
  // The guard writes a record only for a step that the scheduler lost. A sound step gets no write.
  assert.deepEqual(guarded.filter(item => item.woke).map(item => item.ticks), hung)
})
