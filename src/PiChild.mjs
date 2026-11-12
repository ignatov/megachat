import { constants } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { defineDoc, defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable'
import { createReadTool } from '@earendil-works/pi-durable/tools'
import { message } from './messages.mjs'
import { isInside, ProjectReadEnv } from './ProjectReadEnv.mjs'

/** The name of the extension that a pi child selects. It is the only extension of a child conversation. */
export const CHILD_EXTENSION = 'air.megachat.child'
/** The tool rounds of one run of a pi child. A Claude child has 30, and a read-only task needs fewer. */
export const CHILD_TURNS = 20
/** The repository rules that a pi child gets, at most this count of bytes. */
export const RULES_LIMIT = 32000
const RULES_FILES = ['AGENTS.md', 'CLAUDE.md']

/**
 * Marks a child conversation and names the directory that its environment may read. The daemon writes it in the commit
 * that creates the conversation. The main conversation has no such document, so it gets no environment.
 */
export const PiChildDoc = defineDoc({
  kind: 'air.megachat.child', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ root: null }), checkpointWhen: () => true,
})

/**
 * The tool `read` of Pi Durable. It reads at most 2,000 lines or 50 KB of a text file, or one image of at most 4.5 MB,
 * in each call. A read changes nothing, so a call that a daemon stop cut off runs again after the restart.
 */
export const readTool = { ...createReadTool(), replay: 'safe' }

/**
 * The extension of a pi child: the tool `read`, and the count of the cost of each model request of the child. A child
 * uses the Central provider of the main agent, so its cost is in the daily spend.
 */
export function childExtension(countSpend) {
  return defineExtension({ name: CHILD_EXTENSION, tools: [readTool], hooks: [
    hook(GenerationTask, { afterResponse: (answer, api) => countSpend(answer.usage, api.models.getModel(answer.provider, answer.model)) }),
  ] })
}

/** The environment of a conversation for `Harness.open`: a read-only view of the project for a pi child, else none. */
export async function childEnvironment(target, context) {
  const child = await target.read.snapshot(PiChildDoc, target.conversationId, context)
  return child?.root ? new ProjectReadEnv(child.root) : undefined
}

/**
 * The rules of the repository in [cwd] for a pi child: `AGENTS.md`, else `CLAUDE.md`, at most `RULES_LIMIT` bytes. A
 * file whose real path is out of the directory does not count, as for the tool `read`.
 */
async function repositoryRules(cwd) {
  const root = await realpath(cwd)
  for (const name of RULES_FILES) {
    let path
    try { path = await realpath(join(cwd, name)) }
    catch { continue }
    if (!isInside(root, path)) continue
    let file
    try {
      // A FIFO must not wait for a writer, and the real path must not end in a symbolic link that came later.
      file = await open(path, process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      if (!(await file.stat()).isFile()) continue
      const buffer = Buffer.alloc(RULES_LIMIT + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      const text = new TextDecoder().decode(buffer.subarray(0, Math.min(bytesRead, RULES_LIMIT))).trim()
      if (!text) continue
      return { name, text, truncated: bytesRead > RULES_LIMIT }
    }
    catch { continue }
    finally { await file?.close() }
  }
  return undefined
}

/**
 * The instructions of a pi child: what it can do, then the rules of the repository as data of their own. A child gets
 * nothing of the main agent: not its rules, not the rules of the settings, not the instructions of the user.
 */
export async function childInstructions(cwd) {
  const rules = await repositoryRules(cwd).catch(() => undefined)
  return [message('child.pi.instructions', cwd),
    ...(rules ? [`${message('child.pi.rules', rules.name)}\n<repository_rules file="${rules.name}">\n${rules.text}\n</repository_rules>`
      + (rules.truncated ? `\n${message('child.pi.rulesTruncated', RULES_LIMIT)}` : '')] : []),
  ].join('\n\n')
}

/**
 * The choices of a child conversation at each dispatch: the [model], the directory of the run, only the extension of a
 * child with its tool `read`, the child instructions and the turn limit. A follow-up gets them again, so a change of the
 * model or of the repository rules reaches the next run.
 */
export async function childAgent(cwd, model, extension) {
  return { model, cwd, extensions: [extension], tools: [readTool], instructions: await childInstructions(cwd), maxTurns: CHILD_TURNS }
}
