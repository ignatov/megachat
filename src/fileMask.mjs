/**
 * The file mask (umask) of the user. Megachat sets the mask 077, so its state is private to the user. A child agent and
 * each tool that it runs must get the mask that the user had when Megachat started: a file that a task writes in a
 * project must get the mode that the same agent gives it in a terminal.
 *
 * `start` sets 077 before it starts the daemon. So the daemon gets the first mask of the user in this variable, not
 * from its own mask, and it gives the variable to the supervisor of each child. The supervisor applies the mask and
 * removes the variable before it starts the agent.
 *
 * This module has only `node:` imports, because the supervisor loads it.
 */
export const MASK_VARIABLE = 'MEGACHAT_UMASK'

const parse = value => typeof value === 'string' && /^[0-7]{1,4}$/.test(value) ? Number.parseInt(value, 8) & 0o777 : undefined
const format = mask => mask.toString(8).padStart(3, '0')

/** Sets the mask 077 for this process. [environment] keeps the mask of the user, unless it has one already. */
export function restrictFileMask(environment = process.env) {
  const previous = process.umask(0o077)
  if (parse(environment[MASK_VARIABLE]) === undefined) environment[MASK_VARIABLE] = format(previous)
}

/** The variable that gives the mask of the user to the supervisor of a child. A process without the mask gives none. */
export function fileMaskEnvironment(environment = process.env) {
  const mask = parse(environment[MASK_VARIABLE])
  return mask === undefined ? {} : { [MASK_VARIABLE]: format(mask) }
}

/** Applies the mask of the user from [environment] to this process, and removes the variable from [environment]. */
export function applyFileMask(environment = process.env) {
  const mask = parse(environment[MASK_VARIABLE])
  delete environment[MASK_VARIABLE]
  if (mask !== undefined) process.umask(mask)
}
