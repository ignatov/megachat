// A transparent pipe between Megachat and the real Claude adapter. It copies each ACP line in both directions without a
// change, and writes a short record of the model, the permission mode and the permission requests to TAP_LOG. Each
// record has the key and the base URL of the child removed. Usage: node tap.mjs <command> [<argument>...]
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const secrets = [process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_BASE_URL].filter(value => value && value.length > 7)
const redact = text => secrets.reduce((value, secret) => value.split(secret).join('<redacted>'), text)
  .replace(/http:\/\/127\.0\.0\.1:\d+\/wire\/[^\s"'\\)]*/g, '<central>')
const target = process.env.TAP_LOG
const log = entry => appendFileSync(target, `${redact(JSON.stringify({ at: new Date().toISOString(), ...entry }))}\n`, { mode: 0o600 })
const env = { ...process.env }
delete env.TAP_LOG
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ['pipe', 'pipe', 'inherit'], env })
child.once('exit', code => process.exit(code ?? 1))
const methods = new Map()

function inspect(direction, line) {
  let item
  try { item = JSON.parse(line) }
  catch { return }
  if (item.method && item.id !== undefined) methods.set(`${direction}:${item.id}`, item.method)
  const answered = methods.get(`${direction === 'in' ? 'out' : 'in'}:${item.id}`)
  if (item.method === 'session/new' || item.method === 'session/load') {
    const options = item.params?._meta?.claudeCode?.options
    log({ direction, method: item.method, model: options?.model, settingSources: options?.settingSources,
      allowDangerouslySkipPermissions: options?.allowDangerouslySkipPermissions })
  }
  else if (['session/set_mode', 'session/set_config_option', 'session/set_model'].includes(item.method)) log({ direction, method: item.method, params: item.params })
  else if (item.method === 'session/request_permission') log({ direction, method: item.method, title: item.params?.toolCall?.title,
    options: item.params?.options?.map(option => `${option.optionId}:${option.kind}`) })
  else if (item.method === 'session/update') {
    const update = item.params?.update ?? {}
    if (update.sessionUpdate === 'current_mode_update') log({ direction, update: update.sessionUpdate, mode: update.currentModeId })
    else if (update.sessionUpdate === 'config_option_update') log({ direction, update: update.sessionUpdate,
      options: update.configOptions?.map(option => `${option.id}=${option.currentValue}`) })
    else if (update.sessionUpdate === 'usage_update') log({ direction, update: update.sessionUpdate, data: JSON.stringify(update).slice(0, 600) })
  }
  else if (answered && (item.result !== undefined || item.error !== undefined)) {
    const result = item.result ?? {}
    log({ direction, answerTo: answered, error: item.error?.message, mode: result.modes?.currentModeId,
      model: result.models?.currentModelId, config: result.configOptions?.map(option => `${option.id}=${option.currentValue}`),
      stopReason: result.stopReason, outcome: result.outcome, usage: answered === 'session/prompt' ? result.usage : undefined,
      meta: answered === 'session/prompt' ? JSON.stringify(result._meta ?? null).slice(0, 800) : undefined })
  }
}

createInterface({ input: process.stdin }).on('line', line => { inspect('out', line); child.stdin.write(`${line}\n`) })
process.stdin.on('end', () => child.stdin.end())
createInterface({ input: child.stdout }).on('line', line => { inspect('in', line); process.stdout.write(`${line}\n`) })
