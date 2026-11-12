import { environmentSetting } from './Settings.mjs'

/**
 * The setting `reply.suggestions` or `MEGACHAT_SUGGESTIONS` selects the mode of the next-step suggestions:
 * - `off`, the default: the agent offers a next step only when the user asks for one.
 * - `reply`: the agent gets the suggestion rules and the tools `agents_suggest` and `agents_feedback`, and it writes the
 *   proposal into the reply text.
 * - `ghost`: the agent gets the rules of `resources/instructions-suggestions-ghost.md` and the same tools. The proposal
 *   is not in the reply text. The bridge sends it as a prompt suggestion to each client. Air shows it as grey text in
 *   its empty prompt input, and a client that does not know the key ignores it.
 * The stored suggestion state stays in each mode.
 */
export { SUGGESTION_MODES, SUGGESTIONS_VARIABLE } from './Settings.mjs'

/**
 * The lifetime of a prompt suggestion: one hour, the lifetime of the default prompt cache. After that time the
 * suggestion is old, and Megachat withdraws it. Only the daemon reads the time. The wire does not carry it.
 */
export const PROMPT_SUGGESTION_LIFETIME_MS = 3600000

/** The mode of the suggestions from the environment alone, without the stored settings. */
export function suggestionsMode(environment = process.env) {
  return environmentSetting('reply.suggestions', environment)
}

/**
 * The prompt suggestion of [state] that a client can show at the time [now]: the suggestion of a finished turn, before
 * its `expiresAt`. A suggestion of the turn that runs is not ready yet.
 */
export function livePromptSuggestion(state, now = Date.now()) {
  const suggestion = state?.initiative?.promptSuggestion
  if (!suggestion || state.current?.requestId === suggestion.turnId) return null
  return Date.parse(suggestion.expiresAt) > now ? suggestion : null
}

/**
 * The ACP update that carries a prompt suggestion: a `session_info_update` without a title, with the key that Air reads
 * at the top level of its `_meta`, `promptSuggestions`. Air shows the first text that is not blank. A client that does
 * not know the key ignores it by the rules of ACP. [withdrawn] gives an empty list, and Air then removes the text. The
 * ID, the turn and the expiry of the suggestion stay in the daemon. This is the only place that knows the carrier.
 */
export function promptSuggestionUpdate({ text }, withdrawn = false) {
  return { sessionUpdate: 'session_info_update', _meta: { promptSuggestions: { suggestions: withdrawn ? [] : [{ text }] } } }
}
