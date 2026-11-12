import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { fakeModels, MAIN } from './parallel-models.mjs'

/**
 * The highest count of the delays that the test tries. Pi Durable 1.5.0 lost the wake-up of the step at the delay 24
 * (issue #25), and Pi Durable 1.5.1 has the fix. The range is wide, so that a change of the timing of the scheduler
 * does not move the time in which a pass plans out of the scan.
 */
const MAX_TICKS = 300
/** A turn of a scan that has no end in this time hangs. A sound turn ends in some milliseconds. */
const HANG_MS = 1500

/**
 * The storage of the test. The end of each storage commit that ends a tool task comes [ticks] microtasks late. So the
 * publication of the end of a tool call moves through the work of the scheduler in steps of one microtask. One count
 * puts it into the time in which a pass of the scheduler plans, where Pi Durable 1.5.0 lost the wake-up.
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
 * One turn of the user in which the main agent starts a task in each of [projects] in one reply, as in issue #25.
 * Gives `ended` or `hang`, the tool results that the second model request got, and the current turn after the turn.
 */
async function turn(directory, projects, ticks) {
  const spawn = fauxAssistantMessage(projects.map((cwd, index) => fauxToolCall('agents_spawn', { cwd, prompt: `Task ${index}.` })), { stopReason: 'toolUse' })
  const { models, requests } = fakeModels([spawn, fauxAssistantMessage('Started.')], [])
  const service = await PiMegachatService.open(lateToolEnds(ticks), models, undefined, {},
    { settingsPath: join(directory, 'settings.json'), spendPath: join(directory, `spend-${projects.length}-${ticks}.json`), keepAlive: { enabled: false },
      environment: {} })
  try {
    for (const cwd of projects) await service.state.addWorkspace(cwd)
    await service.resume()
    const receipt = await service.submit(`input-${ticks}`, 'Start the tasks.')
    let timer
    const end = await Promise.race([service.waiters.get(receipt.mainRunId).then(() => 'ended'),
      new Promise(resolve => { timer = setTimeout(resolve, HANG_MS, 'hang') })])
    clearTimeout(timer)
    const last = requests.at(-1)?.messages ?? ''
    return { end, results: (last.match(/"role":"toolResult"/g) ?? []).length, current: (await service.state.snapshot()).current }
  }
  finally {
    await service.close()
  }
}

for (const count of [2, 3]) {
  test(`a turn with ${count} tool calls in one reply ends at each delay of the end of a tool task`, { timeout: 120000 }, async t => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-wake-')))
    t.after(() => rm(directory, { force: true, recursive: true }))
    const projects = Array.from({ length: count }, (_, index) => join(directory, `p${index}`))
    for (const project of projects) await mkdir(project)
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values: { 'coordinator.model': MAIN } }), { mode: 0o600 })
    const failures = []
    for (let ticks = 0; ticks <= MAX_TICKS; ticks++) {
      const item = await turn(directory, projects, ticks)
      if (item.end !== 'ended' || item.results !== count || item.current !== null) failures.push({ ticks, ...item })
    }
    // Each turn ends, the conversation has no current turn, and the main agent gets each tool result in its next request.
    assert.deepEqual(failures, [])
  })
}
