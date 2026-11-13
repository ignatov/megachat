import { existsSync } from 'node:fs'
import { chmod, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai/models'
import { MODEL_THINKING_LEVELS } from '@earendil-works/pi-ai/providers/model-schema'
import { logEvent, message, MegachatError, requireCondition } from './messages.mjs'
import { directoryKey, expandHome, isWithin } from './ProjectDirectories.mjs'
import { DEFAULT_WORKDAY_DAYS, knownTimezone, resolvedTimezone, SYSTEM_TIMEZONE, WEEKDAYS } from './Workday.mjs'

/** The size of the model context, in tokens, above which the conversation gets a summary. This variable replaces it. */
export const COMPACT_TOKENS_VARIABLE = 'MEGACHAT_COMPACT_TOKENS'
export const DEFAULT_COMPACT_TOKENS = 100000
/** The lifetime of the prompt cache that each model request asks for: `1h` or `5m`. */
export const CACHE_TTL_VARIABLE = 'MEGACHAT_CACHE_TTL'
/** The value `0` stops each keep-alive request and each summary of an idle conversation. */
export const KEEPALIVE_VARIABLE = 'MEGACHAT_KEEPALIVE'
/** The time after the last turn, in hours, in which keep-alive requests go out. */
export const KEEPALIVE_HOURS_VARIABLE = 'MEGACHAT_KEEPALIVE_HOURS'
export const DEFAULT_KEEPALIVE_HOURS = 6
/**
 * The mode of the next-step suggestions: `off`, `reply` or `ghost`. The values `0` and `1` of earlier builds give `off`
 * and `reply`.
 */
export const SUGGESTIONS_VARIABLE = 'MEGACHAT_SUGGESTIONS'
/**
 * The modes of the next-step suggestions. `reply` puts the proposal into the reply text. `ghost` sends it to the
 * prompt input of Air.
 */
export const SUGGESTION_MODES = ['off', 'reply', 'ghost']
export const DEFAULT_MODEL = 'anthropic/claude-opus-5-5'
/** The model of a pi child: small and cheap, for a task that only reads files. */
export const DEFAULT_PI_MODEL = 'anthropic/claude-haiku-5-5'
/**
 * The model that the options of a Claude child name. With `children.claudeModel` `inherit`, the model of the settings of
 * Claude Code wins over it, and only without such a model does it apply. Claude Code gets the model ID without the provider.
 */
export const DEFAULT_CLAUDE_MODEL = 'anthropic/claude-sonnet-5-5'
/** The cache retention of pi-ai for each value of `cache.ttl`. */
export const CACHE_RETENTION = { '1h': 'long', '5m': 'short' }
export const ONBOARDING_STATES = ['pending', 'done', 'skipped']
/** The default agents of a new child task. A pi child cannot change code, so it is no default: the user names it. */
export const CHILD_AGENTS = ['claude', 'codex']
/** The time limit of a child run in minutes by default, the value of `children.timeoutMinutes`. */
export const DEFAULT_CHILD_TIMEOUT_MINUTES = 240

/**
 * The time limit in milliseconds of a child run from the settings [values] of its directory. 0 gives no limit.
 */
export function childDeadlineMs(values) {
  const minutes = values['children.timeoutMinutes'] ?? DEFAULT_CHILD_TIMEOUT_MINUTES
  return minutes * 60000
}

/** The count of the child runs that run at the same time by default, and the highest count of `children.parallel`. */
export const DEFAULT_PARALLEL_CHILDREN = 3
export const MAX_PARALLEL_CHILDREN = 8
/** The steps of a child that the user allows, forbids, or allows only after a question. */
export const CHILD_STEPS = ['commit', 'push', 'daemonRestart']
const CHILD_PERMISSIONS = ['allow', 'ask', 'deny']
/**
 * The permission mode of Claude Code for each value of `children.permissionMode`. This is the one map from a value of
 * the setting to a mode name of Claude Code. `inherit` sends no mode, so the settings of Claude Code decide. Megachat
 * offers no `bypassPermissions`. It offers no `plan` either: the approval of a plan has options that switch the child
 * to `auto` or to `bypassPermissions`, so the answer to a permission request, not the setting, gives the next mode.
 */
export const CLAUDE_PERMISSION_MODES = { inherit: undefined, ask: 'default', allowEdits: 'acceptEdits', auto: 'auto' }
const SCHEMA = 1

const toBoolean = value => typeof value === 'boolean' ? value
  : typeof value !== 'string' ? undefined
    : /^(on|true|yes|1)$/i.test(value.trim()) ? true : /^(off|false|no|0)$/i.test(value.trim()) ? false : undefined
const toNumber = value => typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim()) : NaN
const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
/** A local time of the day as `HH:MM`. `9:00` gives `09:00`. */
const timeOfDay = value => {
  const match = typeof value === 'string' ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim()) : null
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : undefined
}
/**
 * The days of the week in the order of [WEEKDAYS], from a list or from a text with commas. An item is a day, such as
 * `mon` or `Monday`, or a range, such as `mon-fri`. A range can go past Sunday. An empty list is not valid.
 */
const weekdays = value => {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  const days = new Set()
  for (const item of items) {
    if (typeof item !== 'string') return undefined
    const ends = item.trim().toLowerCase().split(/\s*-\s*/).map(name => Math.max(WEEKDAYS.indexOf(name), DAY_NAMES.indexOf(name)))
    if (ends.length > 2 || ends.some(index => index < 0)) return undefined
    for (let index = ends[0]; ; index = (index + 1) % WEEKDAYS.length) {
      days.add(WEEKDAYS[index])
      if (index === ends.at(-1)) break
    }
  }
  return days.size ? WEEKDAYS.filter(day => days.has(day)) : undefined
}
const choice = values => value => typeof value === 'string' && values.includes(value.trim()) ? value.trim() : undefined
/**
 * The mode of the suggestions for a stored or a given value. `settings.json` of v0.3.0 holds `true` or `false`, and the
 * tool of v0.3.0 took the words of a boolean. So these values give `reply` and `off`.
 */
export const suggestionMode = value => {
  const mode = choice(SUGGESTION_MODES)(typeof value === 'string' ? value.toLowerCase() : value)
  if (mode !== undefined) return mode
  const on = toBoolean(value)
  return on === undefined ? undefined : on ? 'reply' : 'off'
}

/** Splits `provider/modelId` at the first slash, because a model ID of some providers holds a slash. */
export function modelRef(value) {
  const index = value.indexOf('/')
  return { provider: value.slice(0, index), modelId: value.slice(index + 1) }
}

const modelOf = (models, value) => {
  const { provider, modelId } = modelRef(value)
  return models?.getModel(provider, modelId)
}
const knownModel = (value, { models }) => typeof value === 'string' && /^[^/\s]+\/\S+$/.test(value.trim()) && modelOf(models, value.trim())
  ? value.trim() : undefined
/**
 * A model ID of Claude Code: a name such as `claude-sonnet-5-5` or the alias `fable`, with an optional context hint such
 * as `[1m]`.
 */
const CLAUDE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\[[A-Za-z0-9]{1,16}\])?$/
/**
 * `inherit`, or a model of Claude Code as `anthropic/<model ID>`, as the key of Central serves it. The model registry
 * need not know the model: Claude Code has models and aliases that the registry does not have, such as `fable`. The
 * adapter refuses a model that Claude Code does not offer, and the run then fails before its prompt.
 */
const claudeModel = value => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === 'inherit') return 'inherit'
  return text.startsWith('anthropic/') && CLAUDE_MODEL_ID.test(modelRef(text).modelId) ? text : undefined
}
/**
 * A model ID of Codex, such as `gpt-5.5`. It has no reasoning level in brackets: the adapter selects the model by its
 * base ID, and the model keeps its reasoning level.
 */
const CODEX_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
/**
 * `inherit`, or a model of Codex as `openai/<model ID>`, as the model registry names an OpenAI model. The registry need
 * not know the model: the Codex adapter lists its own models. The adapter refuses a model that is not in its list, and
 * the run then fails before its prompt.
 */
const codexModel = value => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === 'inherit') return 'inherit'
  return text.startsWith('openai/') && CODEX_MODEL_ID.test(modelRef(text).modelId) ? text : undefined
}
const modelValues = ({ models }) => ({ values: models.getModels().map(model => ({ value: `${model.provider}/${model.id}`, name: model.name,
  contextWindow: model.contextWindow, usdPerMillionTokens: model.cost })), note: message('settings.model.measurement') })
const thinkingLevels = model => model?.reasoning ? getSupportedThinkingLevels(model) : [...MODEL_THINKING_LEVELS]

/**
 * The settings of Megachat. Each item is the one place that defines a setting:
 * - `key` names it in `settings.json` and in the tool `agents_settings`. `setting.<key>` in the resources describes it.
 * - `variable` names the environment variable that wins over the stored value.
 * - `fromEnvironment` reads the text of the variable. A text that it cannot read gives `undefined`, and the variable
 *   then has no effect. Without it, `validate` reads the text.
 * - `validate` gives the normalized value, or `undefined` for an invalid value. It gets the models and the effective
 *   model of the main agent.
 * - `allowed` gives the allowed values or the range for the output of `get`.
 * - `applies` tells when a change has an effect: `settings.applies.<applies>` in the resources says it to the user.
 * - `project` marks a setting of one child run. Such a setting can have a value for one project directory. Each other
 *   setting applies to the daemon as a whole, so it has only the global value.
 */
export const SETTINGS = [
  { key: 'coordinator.model', default: DEFAULT_MODEL, applies: 'nextTurn', validate: knownModel, allowed: modelValues },
  { key: 'coordinator.thinking', default: 'low', applies: 'nextTurn',
    validate: (value, { model }) => {
      const level = choice(MODEL_THINKING_LEVELS)(value)
      return level !== undefined && thinkingLevels(model).includes(level) ? level : undefined
    },
    allowed: ({ model }) => ({ values: thinkingLevels(model) }) },
  { key: 'keepAlive.enabled', variable: KEEPALIVE_VARIABLE, default: true, applies: 'nextTurn',
    // Each value of the variable other than `0` keeps the keep-alive requests, as before the settings.
    fromEnvironment: text => text !== '0', validate: toBoolean, allowed: () => ({ values: [true, false] }) },
  { key: 'keepAlive.hours', variable: KEEPALIVE_HOURS_VARIABLE, default: DEFAULT_KEEPALIVE_HOURS, applies: 'nextTurn',
    validate: value => {
      const hours = toNumber(value)
      return Number.isFinite(hours) && hours >= 0 && hours <= 168 ? hours : undefined
    },
    allowed: () => ({ minimum: 0, maximum: 168 }) },
  { key: 'cache.ttl', variable: CACHE_TTL_VARIABLE, default: '1h', applies: 'nextTurn',
    validate: choice(Object.keys(CACHE_RETENTION)), allowed: () => ({ values: Object.keys(CACHE_RETENTION) }) },
  { key: 'compaction.tokens', variable: COMPACT_TOKENS_VARIABLE, default: DEFAULT_COMPACT_TOKENS, applies: 'nextTurn',
    validate: value => {
      const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
      return /^[1-9]\d{0,8}$/.test(text) ? Number(text) : undefined
    },
    allowed: () => ({ minimum: 1, maximum: 999999999 }) },
  { key: 'workday.enabled', default: false, applies: 'nextTurn', validate: toBoolean, allowed: () => ({ values: [true, false] }) },
  { key: 'workday.start', default: '09:00', applies: 'nextTurn', validate: timeOfDay, allowed: () => ({ other: message('settings.time.other') }) },
  { key: 'workday.end', default: '19:00', applies: 'nextTurn', validate: timeOfDay, allowed: () => ({ other: message('settings.time.other') }) },
  { key: 'workday.days', default: DEFAULT_WORKDAY_DAYS, applies: 'nextTurn', validate: weekdays,
    allowed: () => ({ values: WEEKDAYS, other: message('settings.days.other') }) },
  { key: 'workday.timezone', default: SYSTEM_TIMEZONE, applies: 'nextTurn',
    validate: value => {
      const text = typeof value === 'string' ? value.trim() : ''
      if (text.toLowerCase() === SYSTEM_TIMEZONE) return SYSTEM_TIMEZONE
      return /^[A-Za-z][\w+/-]{0,63}$/.test(text) && knownTimezone(text) ? text : undefined
    },
    allowed: () => ({ values: [SYSTEM_TIMEZONE], other: message('settings.timezone.other', resolvedTimezone(SYSTEM_TIMEZONE)) }) },
  { key: 'workday.idleMinutes', default: 30, applies: 'nextTurn',
    validate: value => {
      const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
      return /^\d{1,4}$/.test(text) && Number(text) <= 1440 ? Number(text) : undefined
    },
    allowed: () => ({ minimum: 0, maximum: 1440 }) },
  { key: 'report.morning', default: false, applies: 'nextTurn', validate: toBoolean, allowed: () => ({ values: [true, false] }) },
  // The approval of the user for the automatic stop of a copy of npx for a new release (see `MegachatUpdate.mjs`).
  { key: 'update.auto', default: false, applies: 'update', validate: toBoolean, allowed: () => ({ values: [true, false] }) },
  { key: 'reply.suggestions', variable: SUGGESTIONS_VARIABLE, default: 'off', applies: 'nextTurn',
    fromEnvironment: text => text === '1' ? 'reply' : text === '0' ? 'off' : choice(SUGGESTION_MODES)(text.toLowerCase()),
    validate: suggestionMode, allowed: () => ({ values: SUGGESTION_MODES }) },
  { key: 'reply.language', default: 'auto', applies: 'nextTurn',
    validate: value => typeof value !== 'string' ? undefined : /^auto$/i.test(value.trim()) ? 'auto'
      : /^\p{L}[\p{L} ()-]{0,39}$/u.test(value.trim()) ? value.trim() : undefined,
    allowed: () => ({ values: ['auto'], other: message('settings.language.other') }) },
  { key: 'reply.length', default: 'short', applies: 'nextTurn',
    validate: choice(['short', 'normal', 'detailed']), allowed: () => ({ values: ['short', 'normal', 'detailed'] }) },
  { key: 'reply.quoteRequest', default: false, applies: 'nextTurn', validate: toBoolean, allowed: () => ({ values: [true, false] }) },
  { key: 'children.agent', default: 'claude', applies: 'nextChild', project: true, validate: choice(CHILD_AGENTS), allowed: () => ({ values: CHILD_AGENTS }) },
  // The value 1 runs one child at a time, as the builds up to v0.3.0 did.
  { key: 'children.parallel', default: DEFAULT_PARALLEL_CHILDREN, applies: 'nextChild',
    validate: value => {
      const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
      return /^\d$/.test(text) && Number(text) >= 1 && Number(text) <= MAX_PARALLEL_CHILDREN ? Number(text) : undefined
    },
    allowed: () => ({ minimum: 1, maximum: MAX_PARALLEL_CHILDREN }) },
  // The list of the models is long, and `coordinator.model` gives it already.
  { key: 'children.piModel', default: DEFAULT_PI_MODEL, applies: 'nextChild', project: true, validate: knownModel,
    allowed: () => ({ other: message('settings.piModel.other') }) },
  { key: 'children.claudeModel', default: 'inherit', applies: 'nextChild', project: true, validate: claudeModel,
    allowed: () => ({ values: ['inherit'], other: message('settings.claudeModel.other') }) },
  { key: 'children.codexModel', default: 'inherit', applies: 'nextChild', project: true, validate: codexModel,
    allowed: () => ({ values: ['inherit'], other: message('settings.codexModel.other') }) },
  { key: 'children.permissionMode', default: 'inherit', applies: 'nextChild', project: true, validate: choice(Object.keys(CLAUDE_PERMISSION_MODES)),
    allowed: () => ({ values: Object.keys(CLAUDE_PERMISSION_MODES) }) },
  { key: 'children.commit', default: 'allow', applies: 'nextChild', project: true, validate: choice(CHILD_PERMISSIONS), allowed: () => ({ values: CHILD_PERMISSIONS }) },
  { key: 'children.push', default: 'ask', applies: 'nextChild', project: true, validate: choice(CHILD_PERMISSIONS), allowed: () => ({ values: CHILD_PERMISSIONS }) },
  { key: 'children.daemonRestart', default: 'ask', applies: 'nextChild', project: true, validate: choice(CHILD_PERMISSIONS),
    allowed: () => ({ values: CHILD_PERMISSIONS }) },
  // The time limit of a child run in minutes. 0 gives no limit. A run keeps the value of its start.
  { key: 'children.timeoutMinutes', default: DEFAULT_CHILD_TIMEOUT_MINUTES, applies: 'nextChild', project: true,
    validate: value => {
      const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
      return /^\d{1,4}$/.test(text) && Number(text) <= 1440 ? Number(text) : undefined
    },
    allowed: () => ({ minimum: 0, maximum: 1440 }) },
  { key: 'projects.newRoot', default: '~/src', applies: 'nextCall',
    // The value must be a path that each create can use: an absolute path after the expansion of `~`, as the create
    // expands it on this platform.
    validate: value => {
      const path = typeof value === 'string' ? value.trim().replace(/(.)[/\\]+$/, '$1') : ''
      return path && path.length <= 4096 && !path.includes('\0') && isAbsolute(expandHome(path)) ? path : undefined
    },
    allowed: () => ({ other: message('settings.newRoot.other') }) },
  { key: 'budget.dailyUsd', default: 0, applies: 'nextTurn',
    validate: value => {
      const usd = toNumber(value)
      return Number.isFinite(usd) && usd >= 0 && usd <= 100000 ? usd : undefined
    },
    allowed: () => ({ minimum: 0, maximum: 100000 }) },
  // The cap of the size of `memory.md`, the learned memory, in characters. A hand edit can make the file longer.
  { key: 'memory.characters', default: 4000, applies: 'nextTurn',
    validate: value => {
      const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
      return /^\d{4,5}$/.test(text) && Number(text) >= 1000 && Number(text) <= 20000 ? Number(text) : undefined
    },
    allowed: () => ({ minimum: 1000, maximum: 20000 }) },
  // The background pass that adds entries to `memory.md` from the conversation. `false` stops it.
  { key: 'memory.reflection', default: true, applies: 'nextTurn', validate: toBoolean, allowed: () => ({ values: [true, false] }) },
  // The consent of the user to the index of the past sessions. Without it, Megachat reads no session file for the index.
  { key: 'sessions.index', default: 'off', applies: 'now',
    validate: value => { const on = toBoolean(value); return on === undefined ? undefined : on ? 'on' : 'off' },
    allowed: () => ({ values: ['on', 'off'] }) },
  { key: 'sessions.days', default: 180, applies: 'now',
    validate: value => {
      const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
      return /^\d{1,4}$/.test(text) && Number(text) <= 3650 ? Number(text) : undefined
    },
    allowed: () => ({ minimum: 0, maximum: 3650 }) },
  // The notes about the agent sessions that wait for the user. They read the session logs, so they need the consent
  // `sessions.index` too: without it, the notes stay off.
  { key: 'sessions.notes', default: 'off', applies: 'notes',
    validate: value => { const on = toBoolean(value); return on === undefined ? undefined : on ? 'on' : 'off' },
    allowed: () => ({ values: ['on', 'off'] }) },
]

/** True when the notes about the waiting sessions are on: the setting `sessions.notes` and the consent `sessions.index`. */
export const notesOn = values => values['sessions.notes'] === 'on' && values['sessions.index'] === 'on'

const definitions = new Map(SETTINGS.map(definition => [definition.key, definition]))
/** The keys of the settings that can have a project value. */
export const PROJECT_SETTINGS = SETTINGS.filter(definition => definition.project).map(definition => definition.key)
/**
 * The keys of the settings that an earlier build had and this build removed. Megachat up to v0.3.0 had the settings of
 * the project events, `events.enabled` and `events.ignore`. This build ignores a stored value of them, as it ignores
 * each key that it does not know, and the next write of the file drops them. A key of a newer build stays in the file.
 */
const REMOVED_KEYS = ['events.enabled', 'events.ignore']

/** The value of a variable for [definition], or `undefined` when the variable is unset, blank or invalid. */
function environmentValue(definition, environment) {
  const text = definition.variable ? environment[definition.variable]?.trim() : undefined
  if (!text) return undefined
  return definition.fromEnvironment ? definition.fromEnvironment(text) : definition.validate(text, {})
}

/** The value of [key] from the environment, else its default. A caller without the stored settings uses it. */
export function environmentSetting(key, environment = process.env) {
  const definition = definitions.get(key)
  return environmentValue(definition, environment) ?? definition.default
}

const emptySettings = () => ({ schema: SCHEMA, onboarding: 'pending', values: {} })
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
/**
 * The project values of [data] by the real path of the project directory. The key `projects` is optional: a file of
 * v0.3.0 or older has none. A `projects` of another shape gives no project value, and the file keeps it.
 */
const projectsOf = data => isRecord(data.projects) ? data.projects : {}

/** Gives the reason why [data] is no valid content of `settings.json`, or `undefined` for valid content. */
function invalidReason(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return 'shape'
  if (data.schema !== SCHEMA) return 'schema'
  if (!ONBOARDING_STATES.includes(data.onboarding)) return 'onboarding'
  if (data.values === null || typeof data.values !== 'object' || Array.isArray(data.values)) return 'values'
  return undefined
}

/**
 * The file `settings.json` in the state directory. It is not in the conversation state, because the daemon needs the
 * model and the cache settings before it opens the harness, and because a compaction cannot change it. The user can
 * read it. Without a path, the settings stay in memory, for a test.
 */
export class SettingsStore {
  /** A file that the daemon cannot read stays next to the path under another name, and the defaults apply. */
  static async open(path) {
    if (!path) return new SettingsStore(undefined, emptySettings())
    let text
    try { text = await readFile(path, 'utf8') }
    catch (error) {
      if (error.code === 'ENOENT') return new SettingsStore(path, emptySettings())
      throw error
    }
    let data
    let reason
    try { data = JSON.parse(text); reason = invalidReason(data) }
    catch { reason = 'json' }
    if (!reason) return new SettingsStore(path, data)
    const aside = `${path}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`
    await rename(path, aside)
    logEvent('log.settings.unreadable', reason, basename(aside))
    return new SettingsStore(path, emptySettings())
  }

  constructor(path, data) {
    this.path = path
    this.data = data
    this.queue = Promise.resolve()
  }

  get onboarding() { return this.data.onboarding }

  stored(key) { return Object.hasOwn(this.data.values, key) ? this.data.values[key] : undefined }

  /** Each project directory with its stored values, as `[directory, values]`, in the order of the directories. */
  projects() {
    return Object.entries(projectsOf(this.data)).filter(([, values]) => isRecord(values))
      .sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)
  }

  /** Writes a changed copy. The temporary file and the rename keep a complete file also after a crash. */
  change(operation) {
    const next = this.queue.then(async () => {
      const data = structuredClone(this.data)
      operation(data)
      for (const key of REMOVED_KEYS) delete data.values[key]
      if (this.path) {
        const temporary = `${this.path}.${process.pid}.tmp`
        await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
        if (process.platform !== 'win32') await chmod(temporary, 0o600)
        await rename(temporary, this.path)
      }
      this.data = data
    })
    this.queue = next.catch(() => {})
    return next
  }
}

/**
 * The effective settings: an explicit option of the caller, then the environment variable, then the project value,
 * then the stored setting, then the default. An option comes only from a test or a development caller. Each entry tells
 * its source. A project value applies only to a setting of a child run, and only when the caller names the directory of
 * the run. [home] replaces the home directory for a `~` in a project path, for a test.
 */
export class MegachatSettings {
  constructor(store, { environment = process.env, overrides = {}, models, home } = {}) {
    Object.assign(this, { store, environment, overrides, models, home })
  }

  get onboarding() { return this.store.onboarding }

  /** The context of a validation: the models, and the effective model of the main agent. */
  context() {
    const context = { models: this.models }
    return { ...context, model: modelOf(this.models, this.entry('coordinator.model', context).value) }
  }

  /**
   * The project value of [key] for the directory [real], a real path: the valid value of the nearest project directory
   * that is [real] or holds it. A stored value that this build does not accept counts as no value.
   */
  projectValue(key, real, context) {
    let found
    for (const [directory, values] of this.store.projects()) {
      if (!Object.hasOwn(values, key) || !isWithin(real, directory) || found && found.project.length >= directory.length) continue
      const value = definitions.get(key).validate(values[key], context)
      if (value !== undefined) found = { project: directory, value }
    }
    return found
  }

  /** The entry of [key]. With the real path [directory] of a child run, a project value of a setting of a run applies. */
  entry(key, context = this.context(), directory) {
    const definition = definitions.get(key)
    const stored = this.store.stored(key)
    const valid = stored === undefined ? undefined : definition.validate(stored, context)
    const fromEnvironment = environmentValue(definition, this.environment)
    const project = directory !== undefined && definition.project ? this.projectValue(key, directory, context) : undefined
    const [value, source] = Object.hasOwn(this.overrides, key) ? [this.overrides[key], 'option']
      : fromEnvironment !== undefined ? [fromEnvironment, 'environment']
        : project ? [project.value, 'project']
          : valid !== undefined ? [valid, 'setting'] : [definition.default, 'default']
    // A stored level that the model does not know becomes the nearest level of the model, so each request agrees.
    const effective = key === 'coordinator.thinking' && context.model?.reasoning ? clampThinkingLevel(context.model, value) : value
    return { key, value: effective, source, default: definition.default,
      ...(definition.variable ? { variable: definition.variable } : {}),
      ...(stored === undefined ? {} : { stored }),
      ...(stored !== undefined && valid === undefined ? { storedIgnored: true } : {}),
      ...(valid !== undefined && source !== 'setting' ? { storedHidden: true } : {}),
      ...(project ? { project: project.project } : {}),
      ...(project && source !== 'project' ? { projectHidden: true } : {}) }
  }

  /**
   * Each effective value by its key. With the directory [cwd] of a child run, the project values of that directory
   * apply. The directory need not be a real path.
   */
  values(cwd) {
    const context = this.context()
    const real = cwd === undefined ? undefined : directoryKey(cwd)
    return Object.fromEntries(SETTINGS.map(({ key }) => [key, this.entry(key, context, real).value]))
  }

  /**
   * The project values that apply, for the rules of the main agent: each project directory with the text
   * `key=value, ...` of its values. A value that a variable hides, or that this build does not accept, is not in it.
   */
  projectRules() {
    const context = this.context()
    return this.store.projects().map(([directory, values]) => [directory, Object.keys(values)
      .filter(key => definitions.get(key)?.project).map(key => this.entry(key, context, directory))
      .filter(entry => entry.source === 'project' && entry.project === directory)
      .map(entry => `${entry.key}=${entry.value}`).join(', ')]).filter(([, text]) => text)
  }

  /**
   * The project values for the output of `get`. A value that this build does not accept is in `ignored`, and the file
   * keeps it. A directory that no longer exists keeps its values and gets `missing`: a reset with its path removes them.
   */
  describeProjects(context) {
    return this.store.projects().map(([directory, stored]) => {
      const values = {}
      const ignored = {}
      for (const [key, value] of Object.entries(stored)) {
        const valid = definitions.get(key)?.project ? definitions.get(key).validate(value, context) : undefined
        if (valid === undefined) ignored[key] = value
        else values[key] = valid
      }
      return { directory, values, ...(Object.keys(ignored).length ? { ignored } : {}), ...(existsSync(directory) ? {} : { missing: true }) }
    })
  }

  /**
   * The real path of the project directory [path] of a call: an absolute path or a path that starts with `~`, of a
   * directory that exists. With [stored], a stored project directory that no longer exists is valid too, so a reset can
   * remove its values.
   */
  async projectDirectory(path, stored = false) {
    const text = typeof path === 'string' ? path.trim() : ''
    requireCondition(text && text.length <= 4096 && !text.includes('\0'), 'settingProject')
    const expanded = expandHome(text, this.home)
    requireCondition(isAbsolute(expanded), 'settingProject')
    const real = await realpath(expanded).catch(() => undefined)
    if (real !== undefined && (await stat(real)).isDirectory()) return real
    const absolute = resolve(expanded)
    requireCondition(stored && Object.hasOwn(projectsOf(this.store.data), absolute), 'settingProject')
    return absolute
  }

  /** The output of `get`: each entry with its allowed values, its description and the time when a change applies. */
  describe() {
    const context = this.context()
    return { onboarding: this.onboarding, settings: SETTINGS.map(definition => ({ ...this.entry(definition.key, context),
      ...(definition.project ? { perProject: true } : {}),
      ...definition.allowed(context), description: message(`setting.${definition.key}`), applies: message(`settings.applies.${definition.applies}`) })),
    projects: this.describeProjects(context), projectsNote: message('settings.projects.note') }
  }

  /**
   * The output of `set` and `reset` for [key], with a note when a variable or an option hides the stored value. With a
   * project [directory], the entry is the entry of a child run in that directory, and `directory` names it.
   */
  report(key, directory) {
    const entry = this.entry(key, this.context(), directory)
    const hidden = entry.source === 'environment' ? message('settings.hidden', entry.variable)
      : entry.source === 'option' ? message('settings.option') : undefined
    return { ...entry, ...(directory === undefined ? {} : { directory }), applies: message(`settings.applies.${definitions.get(key).applies}`),
      ...(hidden ? { note: hidden } : {}) }
  }

  /** Refuses a project value of a setting of the daemon as a whole. */
  requireProjectSetting(key) {
    if (!definitions.get(key).project) throw new MegachatError('settingGlobal', key, PROJECT_SETTINGS.join(', '))
  }

  /** Stores [value] for [key]: the global value, or with [project] the value of that project directory. */
  async set(key, value, project) {
    const definition = definitions.get(key)
    requireCondition(definition, 'settingKey')
    if (project !== undefined) this.requireProjectSetting(key)
    const directory = project === undefined ? undefined : await this.projectDirectory(project)
    const normalized = definition.validate(value, this.context())
    requireCondition(normalized !== undefined, 'settingValue')
    await this.store.change(data => {
      if (directory === undefined) { data.values[key] = normalized; return }
      if (!isRecord(data.projects)) data.projects = {}
      data.projects[directory] = { ...(isRecord(data.projects[directory]) ? data.projects[directory] : {}), [key]: normalized }
    })
    return this.report(key, directory)
  }

  /**
   * Removes the stored value of [key]. With [project], it removes the value of that project directory, so the value of
   * a project that holds it, or the global value, applies again. With [project] and no [key], it removes each value of
   * the project.
   */
  async reset(key, project) {
    if (project === undefined) {
      requireCondition(definitions.has(key), 'settingKey')
      await this.store.change(data => { delete data.values[key] })
      return this.report(key)
    }
    requireCondition(key === undefined || definitions.has(key), 'settingKey')
    if (key !== undefined) this.requireProjectSetting(key)
    const directory = await this.projectDirectory(project, true)
    let removed = []
    await this.store.change(data => {
      const values = projectsOf(data)[directory]
      if (!isRecord(values)) return
      removed = Object.keys(values).filter(name => key === undefined || name === key)
      for (const name of removed) delete values[name]
      if (!Object.keys(values).length) delete data.projects[directory]
      // Without a project value, the file has the shape of v0.3.0 again.
      if (!Object.keys(data.projects).length) delete data.projects
    })
    return key === undefined ? { directory, removed } : this.report(key, directory)
  }

  async setOnboarding(status) {
    requireCondition(ONBOARDING_STATES.includes(status), 'settingValue')
    await this.store.change(data => { data.onboarding = status })
    return { onboarding: status }
  }
}
