import { homedir } from 'node:os'
import { ClaudeSessionSource } from './ClaudeSessionSource.mjs'
import { CodexArchiveSource, CodexSessionSource } from './CodexSessionSource.mjs'
import { PiSessionSource } from './PiSessionSource.mjs'

/**
 * The sources of past sessions: one for each agent. Each source has one interface, so the session index and a reader
 * of the tail of a log use the same code:
 * - `agent` is `claude`, `codex` or `pi`. `root` is the directory that holds the session files.
 * - `files(directories, fs)` gives `{ path, directory }` for each session file that can belong to one of the listed
 *   [directories]. `directory` is the listed directory when the path tells it, else undefined. The list can hold a
 *   file of another directory: only the `cwd` of the session tells it.
 * - `relevant(path, directories)` tells whether a changed path, relative to `root`, can be such a session file.
 * - `all(fs)` gives `{ path }` for each session file of the machine, in each directory. `matches(path)` tells whether
 *   a changed path, relative to `root`, has the form of a session file. `nameId(path)` gives the session ID that the
 *   name of a file tells, or undefined. The live table of the running sessions uses these three.
 * - `parse(value, line, path)` reads one parsed JSON line of the file at [path]. It gives `meta` with the known
 *   session data (`sessionId`, `cwd`, `startedAt`, `title`, `titleRank`) and `entry` with `key`, `role`, `tool`,
 *   `timestamp` and `text`, or neither. `role` is `user`, `assistant` or `tool`. `tool` is `call`, `result` or
 *   undefined. `key` is the entry ID of the provider, so a copy of an entry in a fork gets the same key. `step` tells
 *   the step of the session that the line shows: `call`, `result`, `prompt` and `open` while the agent owes the next
 *   step, `reply` and `end` after a finished turn, or undefined for a line that changes no step.
 * - `keepsOpen` is true for an agent that keeps the session file open while the session is loaded: Codex.
 * - `archive` is true for a source of archived sessions: the archived sessions of Codex. The index reads it, and the
 *   live table of the running sessions does not.
 * - `sibling(path)` and `prefers(sibling)`, when a source has them, give the other form of the same session file,
 *   such as the compressed file of a plain file, and tell whether the index takes that form and not [path].
 * `src/SessionLog.mjs` holds the line reader and the helpers of the parsers. The roots come from [home] and
 * [environment], so a test gives its own directories.
 */
export function sessionSources({ home = homedir(), environment = process.env } = {}) {
  return [new ClaudeSessionSource({ home, environment }), new CodexSessionSource({ home, environment }),
    new CodexArchiveSource({ home, environment }), new PiSessionSource({ home, environment })]
}
