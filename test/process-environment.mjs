import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/**
 * The environment that the process [pid] of this user got at its start: the variable names and the `PATH`. Linux
 * gives it in `/proc`. On macOS, `ps -E` writes it after the command line, so a value with a space can give a wrong
 * name. A test that uses this function must not print a value other than the `PATH`, because a value can be a secret.
 */
export async function processEnvironment(pid) {
  let variables
  try {
    variables = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').filter(Boolean)
  }
  catch {
    const { stdout } = await execute('ps', ['-wwE', '-p', String(pid), '-o', 'command='], { maxBuffer: 16 * 1024 * 1024 })
    variables = stdout.trim().split(' ')
  }
  const pairs = variables.map(item => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(item)).filter(Boolean)
  return { names: pairs.map(pair => pair[1]), path: pairs.find(pair => pair[1] === 'PATH')?.[2] ?? '' }
}

/** The first executable [command] in a directory of [path], else `undefined`. */
export async function commandOnPath(command, path) {
  for (const directory of path.split(delimiter).filter(Boolean)) {
    try {
      await access(join(directory, command), constants.X_OK)
      if ((await stat(join(directory, command))).isFile()) return join(directory, command)
    }
    catch { /* This directory has no such command. */ }
  }
  return undefined
}
