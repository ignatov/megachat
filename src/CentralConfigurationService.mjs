import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createModels } from '@earendil-works/pi-ai/models'
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic'
import { logEvent, logFailure, MegachatError, requireCondition } from './messages.mjs'
import { KnownSecrets } from './SessionText.mjs'
import { DEFAULT_CLAUDE_MODEL, modelRef } from './Settings.mjs'

const execute = promisify(execFile)

/** The IDE passes the ACP command of its installed Claude and Codex agents in these variables. */
export const CLAUDE_ACP_VARIABLE = 'MEGACHAT_CLAUDE_ACP'
export const CODEX_ACP_VARIABLE = 'MEGACHAT_CODEX_ACP'

/**
 * Reads an agent command: a JSON array `[command, ...args]`, a JSON object `{ command, args, env, cwd }`, or one executable
 * path. An unset or blank value gives `undefined`, so the caller uses the agent that npm installed with Megachat.
 */
export function agentCommand(value) {
  if (value === undefined || value.trim() === '') return undefined
  let parsed
  try { parsed = JSON.parse(value) }
  catch { return { command: value, args: [], env: {} } }
  if (typeof parsed === 'string') return { command: parsed, args: [], env: {} }
  const strings = list => Array.isArray(list) && list.every(item => typeof item === 'string')
  if (Array.isArray(parsed)) {
    requireCondition(parsed.length > 0 && strings(parsed), 'agentCommand')
    return { command: parsed[0], args: parsed.slice(1), env: {} }
  }
  requireCondition(typeof parsed?.command === 'string' && parsed.command.length > 0 && (parsed.args === undefined || strings(parsed.args))
    && (parsed.env === undefined || (typeof parsed.env === 'object' && Object.values(parsed.env).every(item => typeof item === 'string')))
    && (parsed.cwd === undefined || typeof parsed.cwd === 'string'), 'agentCommand')
  return { command: parsed.command, args: parsed.args ?? [], env: parsed.env ?? {}, ...(parsed.cwd ? { cwd: parsed.cwd } : {}) }
}

/**
 * Asks the model for thinking blocks without text. The chat never shows the thinking. With the display `summarized`,
 * which pi-ai sends by default, the API sends the text of a reply only after the summary of the thinking. So the first
 * part of each reply arrives as one chunk, and a short reply arrives whole at its end. The thinking itself and its cost
 * stay the same. The function wraps the payload hook of Pi Durable, so the hook still sees and changes each request.
 */
const omitThinkingText = onPayload => async (params, model) => {
  const payload = (await onPayload?.(params, model)) ?? params
  return payload.thinking?.display === undefined ? payload : { ...payload, thinking: { ...payload.thinking, display: 'omitted' } }
}

/**
 * Writes a log line for each model request through Central that fails: a request without a response, or a response
 * with an HTTP error status. The provider turns the error into a text that the user does not see, and that text can
 * hold the address of Central. So the line has only the name and the code of the error, or the status. A stop of the
 * request by its caller, such as a cancel of the user, is no failure.
 */
const logFailedRequests = (fetch = globalThis.fetch, signal) => async (input, init) => {
  let response
  try { response = await fetch(input, init) }
  catch (error) {
    if (!signal?.aborted) logFailure('log.model', error)
    throw error
  }
  if (!response.ok) logEvent('log.model.status', response.status)
  return response
}

/**
 * Gives a model without the fallback models of the registry. The Central proxy refuses a request with the field
 * `fallbacks` (HTTP status 400). pi-ai adds that field and the beta `server-side-fallback-2026-07-01` to each request
 * of a model with `compat.allowedFallbackModels`, for example Claude Fable 5.2 and Fable 5. The registry keeps the
 * model as it is, so the list and the prices of the models stay the same.
 */
const withoutFallbacks = model => {
  if (!model?.compat?.allowedFallbackModels) return model
  const { allowedFallbackModels, ...compat } = model.compat
  return { ...model, compat }
}

export class CentralConfigurationService {
  constructor({ central = join(homedir(), '.local/bin/central'), claude = join(homedir(), '.local/bin/claude'),
    settings = join(homedir(), '.claude/settings.json'), environment = process.env } = {}) {
    this.central = central
    this.claude = claude
    this.settings = settings
    this.environment = environment
    /**
     * The exact key and base URL of each Central configuration that this service read. The secret filter of the
     * transcripts and of the session index removes them. They stay in the memory only.
     */
    this.secrets = new KnownSecrets()
  }

  async pi(signal) {
    try {
      const bin = fileURLToPath(new URL('../bin/', import.meta.url))
      const result = await execute(this.central, ['run', 'pi'], {
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
        timeout: 15000, maxBuffer: 128000, signal,
      })
      const configuration = JSON.parse(result.stdout).anthropic
      this.validate(configuration)
      this.remember(configuration)
      return configuration
    }
    catch (error) {
      if (signal?.aborted) throw signal.reason
      // The error of the command holds its output, and that can hold the key. The log gets no message of an error.
      logFailure('log.central.main', error)
      throw new MegachatError('central')
    }
  }

  validate(configuration) {
    requireCondition(configuration && typeof configuration.apiKey === 'string' && configuration.apiKey.trim().length > 0, 'central')
    const url = new URL(configuration.baseUrl)
    requireCondition(url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.search && !url.hash, 'central')
    requireCondition(url.pathname.startsWith('/wire/'), 'central')
  }

  /**
   * Gives the secret filter the exact values of a valid configuration: the key, the base URL, and the path segment
   * after `/wire/`, which holds the key of Central. A configuration can change while the daemon runs, so each read adds
   * its values, and the earlier values stay.
   */
  remember({ baseUrl, apiKey }) {
    const segment = new URL(baseUrl).pathname.slice('/wire/'.length).split('/')[0]
    let decoded
    try { decoded = decodeURIComponent(segment) }
    catch { decoded = segment }
    this.secrets.add(apiKey, apiKey.trim(), baseUrl, baseUrl.replace(/\/+$/, ''), segment, decoded)
  }

  models() {
    const models = createModels()
    const provider = anthropicProvider()
    const omitted = options => ({ ...options, onPayload: omitThinkingText(options?.onPayload),
      fetch: logFailedRequests(options?.fetch, options?.signal) })
    models.setProvider({
      ...provider,
      auth: { apiKey: { name: 'JetBrains Central', resolve: async ({ signal }) => {
        const { baseUrl, apiKey } = await this.pi(signal)
        return { auth: { baseUrl, apiKey }, source: 'JetBrains Central' }
      } } },
      stream: (model, context, options) => provider.stream(withoutFallbacks(model), context, omitted(options)),
      streamSimple: (model, context, options) => provider.streamSimple(withoutFallbacks(model), context, omitted(options)),
    })
    return models
  }

  async childEnvironment() {
    try {
      const settings = JSON.parse(await readFile(this.settings, 'utf8'))
      const baseUrl = settings.env?.ANTHROPIC_BASE_URL
      requireCondition(typeof settings.apiKeyHelper === 'string', 'central')
      const result = await execute('/bin/sh', ['-c', settings.apiKeyHelper], { timeout: 10000, maxBuffer: 64000 })
      const apiKey = result.stdout.trim()
      this.validate({ baseUrl, apiKey })
      this.remember({ baseUrl, apiKey })
      return {
        ...this.baseEnvironment(), ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: apiKey, CLAUDE_CODE_EXECUTABLE: this.claude,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
      }
    }
    catch (error) {
      logFailure('log.central.claude', error)
      throw new MegachatError('central')
    }
  }

  /** The node that runs Megachat comes first on `PATH`, so the `#!/usr/bin/env node` scripts of the agents find it. */
  baseEnvironment() {
    const environment = this.environment
    const variables = Object.fromEntries(['HOME', 'TMPDIR', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK', 'CODEX_HOME']
      .filter(name => environment[name] !== undefined).map(name => [name, environment[name]]))
    return { ...variables, PATH: [dirname(process.execPath), environment.PATH].filter(Boolean).join(delimiter) }
  }

  /** Starts the read-only Codex app-server through the same Central entry point as Codex runs. */
  codexAppServerLaunch() {
    return { command: this.central, args: ['run', 'codex', '--', 'app-server', '--listen', 'stdio://'], env: this.baseEnvironment() }
  }

  /**
   * Claude runs the ACP command that the IDE passed, else the agent that npm installed with Megachat. Codex runs through
   * Central, and `bin/codex` starts the Codex ACP command that the IDE passed. The module system finds the installed
   * agent: in a checkout it is in `node_modules` of the checkout, and in an installed copy it is next to the copy.
   * The model of a Claude launch goes in the options of the session. The model of the settings of Claude Code wins over
   * it, and an explicit value of `children.claudeModel` wins over both.
   */
  async childLaunch(agent) {
    if (agent === 'claude') {
      const claude = agentCommand(this.environment[CLAUDE_ACP_VARIABLE]) ?? { command: process.execPath, env: {},
        args: [fileURLToPath(import.meta.resolve('@agentclientprotocol/claude-agent-acp/dist/index.js'))] }
      return { command: claude.command, args: claude.args, ...(claude.cwd ? { cwd: claude.cwd } : {}),
        model: modelRef(DEFAULT_CLAUDE_MODEL).modelId, env: { ...claude.env, ...await this.childEnvironment() } }
    }
    requireCondition(agent === 'codex')
    const env = this.baseEnvironment()
    const codex = this.environment[CODEX_ACP_VARIABLE]
    if (codex !== undefined) agentCommand(codex)
    return { command: this.central, args: ['run', 'codex', '--'],
      env: { ...env, ...(codex !== undefined ? { [CODEX_ACP_VARIABLE]: codex } : {}),
        PATH: `${fileURLToPath(new URL('../bin/', import.meta.url))}${delimiter}${env.PATH}` } }
  }
}
