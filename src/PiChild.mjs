import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineDoc, defineExtension, defineTool, GenerationTask, hook } from '@earendil-works/pi-durable'
import { getOrThrow } from '@earendil-works/pi-durable/env'
import { createReadTool } from '@earendil-works/pi-durable/tools'
import { obj, opt, str } from '@earendil-works/pi-schema'
import { message } from './messages.mjs'
import { ProjectReadEnv } from './ProjectReadEnv.mjs'

/** The name of the extension that a pi child selects. It is the only extension of a child conversation. */
export const CHILD_EXTENSION = 'air.megachat.child'
/** The repository rules that a pi child gets, at most this count of bytes. */
export const RULES_LIMIT = 32000
/** The tool `ls` gives at most this count of entries of one directory. */
export const LIST_LIMIT = 500
const RULES_FILES = ['AGENTS.md', 'CLAUDE.md']
/** The files of the project rules that Claude Code loads by itself. A symbolic link counts when its target exists. */
const CLAUDE_FILES = ['CLAUDE.md', '.claude/CLAUDE.md']
const context = BACKGROUND_CONTEXT

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
 * The tool `ls` of a pi child: the names of the entries of one directory of the project, `.` by default, with `/` at the
 * end of a directory, hidden entries included, sorted by name, at most `LIST_LIMIT` entries, and `truncated`. It gives
 * no size, no time and no content. It lists only through `listEntries` of `ProjectReadEnv`, which has the path checks
 * of the tool `read`. A list changes nothing, so a call that a daemon stop cut off runs again after the restart.
 */
export const lsTool = defineTool({
  name: 'ls', description: message('child.pi.ls', LIST_LIMIT), replay: 'safe',
  parameters: obj({ path: opt(str({ description: message('child.pi.ls.path'), maxLength: 4096 })) }),
  async execute(args, api, context) {
    // Only the read-only environment of a pi child can list. Without it, the tool refuses the call.
    if (typeof api.env?.listEntries !== 'function') throw new Error(message('error.pi.readOnly'))
    // The errors name the absolute path, as the errors of the tool read do.
    const path = getOrThrow(await api.env.absolutePath(args.path ?? '.', context))
    const { entries, truncated } = getOrThrow(await api.env.listEntries(path, LIST_LIMIT, context))
    const listed = { entries: entries.map(entry => entry.kind === 'directory' ? `${entry.name}/` : entry.name), truncated }
    return { output: [{ type: 'text', text: JSON.stringify(listed) }] }
  },
})

/** The tools of a pi child. Both only read. */
const CHILD_TOOLS = [readTool, lsTool]

/**
 * The extension of a pi child: the tools `read` and `ls`, and the count of the cost of each model request of the child.
 * A child uses the Central provider of the main agent, so its cost is in the daily spend.
 */
export function childExtension(countSpend) {
  return defineExtension({ name: CHILD_EXTENSION, tools: CHILD_TOOLS, hooks: [
    hook(GenerationTask, { afterResponse: (answer, api) => countSpend(answer.usage, api.models.getModel(answer.provider, answer.model)) }),
  ] })
}

/** The environment of a conversation for `Harness.open`: a read-only view of the project for a pi child, else none. */
export async function childEnvironment(target, context) {
  const child = await target.read.snapshot(PiChildDoc, target.conversationId, context)
  return child?.root ? new ProjectReadEnv(child.root) : undefined
}

/**
 * The rules of the repository in [cwd]: the first file of [names] that has text, at most `RULES_LIMIT` bytes. For a pi
 * child, [names] is `AGENTS.md`, else `CLAUDE.md`. The read goes through [env], as for the tool `read`. So a file whose
 * real path is out of the directory, a file that is not a regular file, such as a FIFO, and a path that changes during
 * the open do not count.
 */
export async function repositoryRules(cwd, env = new ProjectReadEnv(cwd), names = RULES_FILES) {
  for (const name of names) {
    const opened = await env.openBinaryReader(name, undefined, context)
    if (!opened.ok) continue
    try {
      const bytes = await opened.value.read(0, RULES_LIMIT + 1, context)
      if (!bytes.ok) continue
      const text = new TextDecoder().decode(bytes.value.subarray(0, RULES_LIMIT)).trim()
      if (!text) continue
      return { name, text, truncated: bytes.value.length > RULES_LIMIT }
    }
    finally { await opened.value.close(context) }
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
    ...(rules ? [rulesBlock(rules, message('child.pi.rules', rules.name), message('child.pi.rulesTruncated', RULES_LIMIT))] : []),
  ].join('\n\n')
}

/**
 * The rules of the repository in [cwd] for a Claude child, as a prompt block, else `undefined`. Claude Code loads
 * `CLAUDE.md` with its imports by itself, but it never reads `AGENTS.md`. So the block holds `AGENTS.md` only when
 * the directory has none of `CLAUDE_FILES`. The read of `AGENTS.md` is the read of the rules of a pi child.
 */
export async function claudeChildRules(cwd) {
  for (const name of CLAUDE_FILES) {
    if (await stat(join(cwd, name)).then(() => true, () => false)) return undefined
  }
  const rules = await repositoryRules(cwd, undefined, ['AGENTS.md'])
  return rules && rulesBlock(rules, message('child.claude.rules', rules.name), message('child.claude.rulesTruncated', RULES_LIMIT))
}

/** The rules of the repository as data of their own: the [intro] line, the text, and the [truncated] line when it applies. */
function rulesBlock(rules, intro, truncated) {
  return `${intro}\n<repository_rules file="${rules.name}">\n${rules.text}\n</repository_rules>`
    + (rules.truncated ? `\n${truncated}` : '')
}

/**
 * The choices of a child conversation at each dispatch: the [model], the directory of the run, only the extension of a
 * child with its tools `read` and `ls` and the child instructions. The choices hold no `maxTurns`, so Pi Durable gives no turn
 * limit, and only the time limit `children.timeoutMinutes` stops a run. A follow-up gets them again, so a change of the
 * model or of the repository rules reaches the next run.
 */
export async function childAgent(cwd, model, extension) {
  return { model, cwd, extensions: [extension], tools: CHILD_TOOLS, instructions: await childInstructions(cwd) }
}
