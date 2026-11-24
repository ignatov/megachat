// The rules of the main agent for the place of a task and for a look: no question where a thing is in a listed project,
// a look before a choice of a project, the task in the project of its means, and no claim about a child without a run.

import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { PiMegachatService } from '../src/PiMegachatService.mjs'

const rules = () => readFile(new URL('../resources/instructions.md', import.meta.url), 'utf8')
const holds = (text, lines) => { for (const line of lines) assert.ok(text.includes(line), line) }

/** The description of the tool [name] of the main agent. The test leaves the temporary directory in place. */
async function description(t, name) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'megachat-look-')))
  const fake = fauxProvider({ models: [{ id: 'fast' }] })
  const models = createModels()
  models.setProvider(fake.provider)
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: 'faux', modelId: 'fast' }, {},
    { settingsPath: join(root, 'settings.json'), keepAlive: { enabled: false }, environment: {} })
  t.after(() => service.close())
  return service.extension().tools.find(item => item.name === name).description
}

test('the rules allow a pi child for a look or when the user names pi, and send each other task to Claude, Codex or Junie', async t => {
  holds(await rules(), ['Use agent=pi for a look, or when the user names pi.', 'Send each other task to Claude, Codex or Junie.',
    'Pass agent=claude, agent=codex or agent=junie when the user names an agent.'])
  assert.ok(!(await rules()).includes('Use agent=pi only when the user names pi.'))
  const spawn = await description(t, 'agents_spawn')
  assert.match(spawn, /Use agent=pi for a look/)
  assert.match(spawn, /agent=junie/)
})

test('the rules forbid a question where a thing is in a listed project, and allow a look in at most 3 projects', async () => {
  holds(await rules(), ['Never ask the user where a thing is in a listed project',
    'tell the child to find the data, the files and the means itself.', 'Look in at most 3 projects for one request.'])
})

test('the rules ask the user only when the choice of a project decides something, and never start a task in a directory that is not listed', async () => {
  const text = await rules()
  holds(text, ['Ask the user only when no listed project fits, or when two or more projects still fit after the looks and the choice changes the result.',
    'Never start a task in a directory that is not listed.'])
  assert.ok(!text.includes('Ask the user when the project is unclear.'))
})

test('the rules define a look, its own result turn and a failed look', async () => {
  holds(await rules(), ['A look is a pi task that answers one question about the content of one listed project',
    'the relative paths and one sentence for each', 'The result of a look comes in its own turn, and that turn cannot start a task.',
    'When a look fails'])
})

test('a look and the task that it proposes keep the rules of a hot child session', async () => {
  const text = await rules()
  holds(text, ['When the request continues the task of a hot child session there, continue that session',
    'A look needs the agent pi, so it does not continue a hot Claude, Codex or Junie session.',
    'It continues a hot Claude, Codex or Junie session only when the request continues the task of that session.',
    'Start a new session with agents_spawn for an unrelated task, for a task that needs another agent than the session has'])
})

test('the rules start a task in the project of its means and keep the Megachat workspace for a task that needs nothing of a project', async () => {
  holds(await rules(), ['start the task in that project, also when the task changes no file there',
    'Start a task in the Megachat workspace, the directory with the origin megachat, only when it needs nothing of a listed project.'])
})

test('the rules take the directory with the newest addedAt for the folder that the user just added', async () => {
  holds(await rules(), ['take the directory with the newest addedAt of agents_list.'])
})

test('the rules forbid a claim that a child lacks a means without a child run in the project of the task', async () => {
  holds(await rules(), ['Do not say that a child lacks a tool, a skill, an MCP server, a login or a token unless a child run in the project of the task reported it.',
    'agents_accounts sees only the start of Claude Code, Codex and Junie in the Megachat workspace',
    'Start the task in its project, and report what the child found.'])
})
