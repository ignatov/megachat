/**
 * The longest time from the start of a process to the first record of a log that the process began itself. pi and
 * Codex write the first record of a new session some seconds after the start of the process. A log that starts later
 * can be a log of another process in the same directory, so it gives no certain link.
 */
export const START_WINDOW_MS = 30000
/** `ps` gives the start time of a process to the second, so a first record can come up to a second before it. */
const START_SLACK_MS = 2000

const inWindow = (row, record) => Number.isFinite(record.startedAt)
  && record.startedAt >= row.startedAt - START_SLACK_MS && record.startedAt <= row.startedAt + START_WINDOW_MS

/**
 * Links each session row to its session logs in the live table [catalog], as a map from a row to a list of
 * `{ record, sessionId }`. `record` is undefined when no log is certain. A link is certain in these cases only:
 * - the state of Megachat names the session ID of a child run;
 * - the process keeps the log open, as Codex does: one row for each open log;
 * - a process file of the agent names the PID, the start time and the session ID, as Claude Code writes;
 * - for the other rows, by the `cwd`: exactly one log of the agent in that directory, not linked to another row,
 *   began in the first 30 seconds of the process, and no other row of the agent in the directory could have begun it.
 * Two processes of one agent in one directory that start at nearly the same time thus get no log, and no row shows
 * the title of another session.
 */
export function linkLogs(rows, catalog) {
  const links = new Map()
  const claimed = new Set()
  const claim = record => { if (record) claimed.add(record.path); return record }
  for (const row of rows) {
    if (row.run) links.set(row, [{ record: row.run.sessionId ? claim(catalog.session(row.agent, row.run.sessionId)) : undefined, sessionId: row.run.sessionId }])
    else if (row.files?.length) {
      const records = row.files.map(path => catalog.get(path)).filter(record => record?.agent === row.agent)
      if (records.length) links.set(row, records.map(record => ({ record: claim(record), sessionId: record.sessionId ?? record.nameId ?? '' })))
    }
    if (!links.has(row) && row.process) links.set(row, [{ record: claim(catalog.session(row.agent, row.process.sessionId)), sessionId: row.process.sessionId }])
  }
  const rest = rows.filter(row => !links.has(row) && row.cwd && catalog.source(row.agent))
  for (const row of rest) {
    const candidates = [...catalog.of(row.agent)].filter(record => record.read && record.cwd === row.cwd && !claimed.has(record.path) && inWindow(row, record))
    const rivals = candidates.length === 1 && rest.some(other => other !== row && other.agent === row.agent && other.cwd === row.cwd && inWindow(other, candidates[0]))
    if (candidates.length === 1 && !rivals) links.set(row, [{ record: candidates[0], sessionId: candidates[0].sessionId ?? '' }])
  }
  for (const row of rows) if (!links.has(row)) links.set(row, [{ record: undefined, sessionId: '' }])
  return links
}
