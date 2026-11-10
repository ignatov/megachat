import { readFileSync } from 'node:fs'

const messages = Object.fromEntries(readFileSync(new URL('../resources/Megachat.properties', import.meta.url), 'utf8')
  .split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const index = line.indexOf('=')
    return [line.slice(0, index), line.slice(index + 1)]
  }))

export function message(key, ...args) {
  if (!(key in messages)) throw new Error(`Unknown message: ${key}`)
  return messages[key].replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)] ?? ''))
}

export class MegachatError extends Error {
  constructor(code) {
    super(message(`error.${code}`))
    this.code = code
  }
}

export function requireCondition(condition, code = 'invalid') {
  if (!condition) throw new MegachatError(code)
}
