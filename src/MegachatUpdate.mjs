import { spawn } from 'node:child_process'
import { logEvent, logFailure, message } from './messages.mjs'
import { ENTRY_GIT_VARIABLES } from './npmEnvironment.mjs'
import { gitCheckout } from './sourceBuildId.mjs'
import { isSleeping, localTime, workdaySettings } from './Workday.mjs'

/**
 * The automatic update (see the capability `update`). The daemon asks the repository for its release tags, compares the
 * highest release with its own version, and shows a notice. A copy of npx with `update.auto` on stops itself when no
 * work runs and the time is right. Then the next start of the entry goes through npx, and npx installs the new release.
 * The daemon starts no daemon, no npx and no npm for the update: the only process of the update is `git ls-remote`.
 */

/** The repository of the releases. `#semver:x` of the entry selects its highest tag `v<version>`. */
export const RELEASE_REPOSITORY = 'https://github.com/ignatov/megachat'
/** A test sets this variable to a local repository, so no test asks GitHub. */
export const RELEASE_REPOSITORY_VARIABLE = 'MEGACHAT_RELEASE_REPOSITORY'
/** The list of the GitHub releases, with their notes. */
export const RELEASE_NOTES_URL = 'https://api.github.com/repos/ignatov/megachat/releases?per_page=30'
/** A test sets this variable to a local address, so no test asks GitHub. */
export const RELEASE_NOTES_URL_VARIABLE = 'MEGACHAT_RELEASE_NOTES_URL'
/**
 * The wait of the first check after the start of the daemon, so the check does not compete with the start. A test
 * sets the variable to a shorter wait.
 */
export const START_DELAY_MS = 60000
export const START_DELAY_VARIABLE = 'MEGACHAT_UPDATE_START_DELAY_MS'
/** The wait of the first check in [environment]: the variable, else [START_DELAY_MS]. */
export function startDelay(environment = process.env) {
  const text = environment[START_DELAY_VARIABLE]
  return /^\d{1,7}$/.test(text ?? '') ? Number(text) : START_DELAY_MS
}
/** The time of a check after a successful check, and after a failed check. */
export const CHECK_INTERVAL_MS = 24 * 3600000
export const RETRY_INTERVAL_MS = 3600000
/** The time between two checks of the conditions of the stop while an update waits. */
export const CONDITION_INTERVAL_MS = 10 * 60000
/** The hard time limit of `git ls-remote`. The variables of git do not end a proxy that never answers `CONNECT`. */
export const GIT_TIMEOUT_MS = 30000
/** The time limit of the request for the release notes. */
export const NOTES_TIMEOUT_MS = 10000
/** The most lines of the message after an update, with the title line. A line has at most [NOTES_LINE_CHARACTERS] characters. */
export const NOTES_LINES = 5
export const NOTES_LINE_CHARACTERS = 160
/** The time between two tries to write the message after an update while a turn or an input blocks it. */
export const NOTE_RETRY_MS = 10000
/** The night window when `workday.enabled` is off: from 01:00 to before 05:00 local time. */
export const NIGHT_START_MINUTE = 60
export const NIGHT_END_MINUTE = 5 * 60
/** The idle time after the last turn of the user before a stop when `workday.enabled` is off. */
export const NIGHT_IDLE_MS = 30 * 60000
/** The wait between the event `update` and the stop, so that the bridges get the event. */
export const ANNOUNCE_MS = 1000

const systemClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => { const timer = setTimeout(callback, delayMs); timer.unref(); return timer },
  clearTimeout: timer => clearTimeout(timer),
}

/** The parts of a release version `1.2.3`, else `undefined`. A pre-release such as `1.2.3-rc.1` is no release. */
export function releaseParts(version) {
  return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : undefined
}

/** The version [version] without the build metadata from `+`: `0.4.0+9.geb044cf` gives `0.4.0`. */
export const baseVersion = version => String(version).split('+')[0]

/** Compares two release versions: a negative number, 0 or a positive number. A version that is no release is lowest. */
export function compareVersions(left, right) {
  const a = releaseParts(baseVersion(left))
  const b = releaseParts(baseVersion(right))
  if (!a || !b) return a ? 1 : b ? -1 : 0
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index]
  return 0
}

/** True when the version [left] is higher than [right], by the base version. */
export const higherVersion = (left, right) => compareVersions(left, right) > 0

/** The highest release in the output of `git ls-remote --tags --refs`, or `undefined`. */
export function highestRelease(output) {
  let highest
  for (const line of String(output).split('\n')) {
    const version = /^[0-9a-f]{7,64}\trefs\/tags\/v(\d+\.\d+\.\d+)$/.exec(line.trim())?.[1]
    if (version && (highest === undefined || higherVersion(version, highest))) highest = version
  }
  return highest
}

/**
 * The highest release of the repository: `git ls-remote --tags --refs`, with the time limits of git of the entry, no
 * prompt for a password, and a SIGKILL after [timeoutMs]. Throws when git fails or the output has no release tag.
 */
export function listRelease({ repository, environment = process.env, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const target = repository ?? (environment[RELEASE_REPOSITORY_VARIABLE] || RELEASE_REPOSITORY)
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['ls-remote', '--tags', '--refs', target], {
      stdio: ['ignore', 'pipe', 'ignore'], env: { ...environment, ...ENTRY_GIT_VARIABLES, GIT_TERMINAL_PROMPT: '0' },
    })
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    timer.unref()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { if (output.length < 1048576) output += chunk })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      if (timedOut) return reject(Object.assign(new Error('git timeout'), { code: 'timeout' }))
      if (code !== 0) return reject(Object.assign(new Error('git failed'), { code: `exit${code ?? ''}` }))
      const release = highestRelease(output)
      if (!release) return reject(Object.assign(new Error('no release'), { code: 'noRelease' }))
      resolve(release)
    })
  })
}

/**
 * True when the package root [root] is a copy of npx: no `.git`, and the path `_npx/<one directory>/node_modules/megachat`.
 * Only such a copy gets a new release at the next start of the entry, so only such a copy stops itself.
 */
export function npxCopy(root) {
  const path = String(root).replace(/[\\/]+$/, '')
  return /[\\/]_npx[\\/][^\\/]+[\\/]node_modules[\\/]megachat$/.test(path) && !gitCheckout(path)
}

/**
 * True when the time [now] allows the automatic stop with the effective settings [values]. With `workday.enabled` on,
 * the conversation must sleep. Else the local time must be in the night window, and the last turn of the user at
 * [userIdleSince] must have ended [NIGHT_IDLE_MS] before.
 */
export function updateTime(values, now, userIdleSince) {
  const workday = workdaySettings(values)
  if (workday) return isSleeping(workday, now, userIdleSince)
  const { minute } = localTime(now, values['workday.timezone'])
  return minute >= NIGHT_START_MINUTE && minute < NIGHT_END_MINUTE && now - (userIdleSince ?? -Infinity) >= NIGHT_IDLE_MS
}

/** The address of the GitHub release of [version]. */
export const releaseUrl = version => `${RELEASE_REPOSITORY}/releases/tag/v${baseVersion(version)}`

/**
 * The notes of each GitHub release after [from] up to [to], the newest first, as `[{ version, text }]`. The request has
 * the time limit [timeoutMs] and no key. Throws when the server gives no valid answer.
 */
export async function fetchReleaseNotes({ from, to, environment = process.env, timeoutMs = NOTES_TIMEOUT_MS, fetch: get = fetch } = {}) {
  const url = environment[RELEASE_NOTES_URL_VARIABLE] || RELEASE_NOTES_URL
  const response = await get(url, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'megachat' }, signal: AbortSignal.timeout(timeoutMs) })
  if (response.status !== 200) throw Object.assign(new Error('notes status'), { code: `status${response.status}` })
  const releases = await response.json()
  if (!Array.isArray(releases)) throw Object.assign(new Error('notes form'), { code: 'form' })
  return releases.map(release => ({ version: typeof release?.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '', release }))
    .filter(({ version, release }) => releaseParts(version) && !release.draft && !release.prerelease
      && higherVersion(version, from) && !higherVersion(version, to))
    .sort((a, b) => compareVersions(b.version, a.version))
    .map(({ version, release }) => ({ version, text: typeof release.body === 'string' ? release.body.trim() : '' }))
}

/**
 * The fixed text of the message after an update of [notice]: `{ from, to, notes }`. `notes` is `null` when the notes
 * are not available. The text has at most [NOTES_LINES] lines: the title, and the first lines of the notes of the
 * newest release first, without the blank lines and the headings. When the notes are longer, the last line gives the
 * address of the release.
 */
export function updateNoteText({ from, to, notes }) {
  const lines = [message('update.done', baseVersion(from), baseVersion(to))]
  if (!notes) {
    lines.push(message('update.noNotes', releaseUrl(to)))
    return lines.join('\n')
  }
  const body = notes.flatMap(item => item.text.replace(/\r\n?/g, '\n').split('\n')).map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
    .map(line => line.length > NOTES_LINE_CHARACTERS ? `${line.slice(0, NOTES_LINE_CHARACTERS - 1)}…` : line)
  if (body.length <= NOTES_LINES - 1) lines.push(...body)
  else lines.push(...body.slice(0, NOTES_LINES - 2), message('update.more', releaseUrl(to)))
  return lines.join('\n')
}

/**
 * The timers of the update in one daemon. [version] is the version of the daemon. [selfUpdating] is true for a copy
 * of npx. [release] gives the highest release (see [listRelease]). [ready] tells whether the work and the time allow
 * the stop now. [failed] gives the release for which an automatic stop gave no update, or `null`. [stop] records the
 * stop, tells the bridges and stops the daemon. [values] gives the effective settings.
 */
export class UpdateCheck {
  constructor({ version, selfUpdating, release, ready, failed, stop, values, clock = systemClock }) {
    Object.assign(this, { version, selfUpdating, release, ready, failed, stop, values, clock })
    this.available = undefined
    this.closed = false
    this.running = Promise.resolve()
    this.stopping = false
  }

  /** The notice of `/health`, or `undefined` without a higher release. */
  status() {
    return this.available ? { available: this.available, notice: message('update.available', baseVersion(this.version), this.available) } : undefined
  }

  /** Checks after [delayMs], and then by the timers. */
  start(delayMs = 0) {
    this.schedule('check', delayMs)
  }

  schedule(kind, delayMs) {
    if (this.closed) return
    const field = kind === 'check' ? 'checkTimer' : 'conditionTimer'
    if (this[field] !== undefined) this.clock.clearTimeout(this[field])
    this[field] = this.clock.setTimeout(() => {
      this[field] = undefined
      this.running = this.running.then(() => kind === 'check' ? this.check() : this.conditions())
        .catch(error => logFailure('log.update.error', error))
    }, delayMs)
  }

  async check() {
    if (this.closed) return
    let release
    try { release = await this.release() }
    catch (error) {
      logFailure('log.update.check', error)
      this.schedule('check', RETRY_INTERVAL_MS)
      return
    }
    if (this.closed) return
    this.schedule('check', CHECK_INTERVAL_MS)
    const next = higherVersion(release, this.version) ? release : undefined
    if (next && next !== this.available) logEvent('log.update.found', baseVersion(this.version), next)
    this.available = next
    if (next) await this.conditions()
  }

  /** True when this daemon may stop itself for the release [release]. */
  async allowed(release) {
    if (!this.selfUpdating || !this.values()['update.auto']) return false
    const failed = await this.failed()
    return !(failed && !higherVersion(release, failed))
  }

  async conditions() {
    if (this.closed || this.stopping || !this.available) return
    const allowed = await this.allowed(this.available)
    if (this.closed) return
    if (!allowed) {
      // A change of `update.auto` or a newer release can allow the stop later.
      this.schedule('condition', CONDITION_INTERVAL_MS)
      return
    }
    const ready = await this.ready(this.clock.now())
    if (this.closed) return
    if (!ready) {
      this.schedule('condition', CONDITION_INTERVAL_MS)
      return
    }
    this.stopping = true
    logEvent('log.update.stop', baseVersion(this.version), this.available)
    await this.stop(baseVersion(this.version), this.available)
  }

  /** Ends the timers. A check that runs ends without an effect, so a stop of the daemon does not wait for git. */
  close() {
    this.closed = true
    for (const field of ['checkTimer', 'conditionTimer']) {
      if (this[field] !== undefined) this.clock.clearTimeout(this[field])
      this[field] = undefined
    }
  }
}

/**
 * The record of the version at the start of the daemon (see `MegachatState.recordVersion`), and the delivery of the
 * message after an update. The record comes before the publish of the connection file. The request for the notes and
 * the write of the message run in the background: the message goes out on its own when the request ends, or at its
 * time limit [timeoutMs], and when the conversation is idle. A turn of the user does not wait for it. While a turn or an
 * input blocks the write, the daemon tries again each [retryMs]. `notes` of the result ends with the write, and `close()`
 * ends the tries. [fetchNotes] replaces the request, for a test.
 */
export async function recordVersion(state, version, { environment = process.env, fetchNotes = fetchReleaseNotes, timeoutMs = NOTES_TIMEOUT_MS, retryMs = NOTE_RETRY_MS } = {}) {
  const result = await state.recordVersion(version)
  if (result.failed) logEvent('log.update.failed', result.failed, baseVersion(version))
  const notice = result.notice
  let closed = false
  let timer
  let wake
  result.close = () => { closed = true; clearTimeout(timer); wake?.() }
  result.notes = !notice ? Promise.resolve() : (async () => {
    let notes
    try { notes = await fetchNotes({ from: notice.from, to: notice.to, environment, timeoutMs }) }
    catch (error) { logFailure('log.update.notes', error, notice.to) }
    try {
      if (notes !== undefined) await state.updateNotes(notice, notes)
      // The message waits for an idle conversation, also when no client is connected: the conversation keeps it.
      while (!closed && !(await state.writeUpdateNote())) {
        await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, retryMs); timer.unref() })
      }
    }
    catch (error) { if (!closed) logFailure('log.update.noteFailed', error) }
  })()
  return result
}
