import { environmentSetting } from './Settings.mjs'

/**
 * The setting `reply.suggestions` or `MEGACHAT_SUGGESTIONS` selects the mode of the next-step suggestions:
 * - `off`, the default: the agent offers a next step only when the user asks for one.
 * - `reply`: the agent gets the suggestion rules and the tools `agents_suggest` and `agents_feedback`, and it writes the
 *   proposal into the reply text.
 * - `ghost`: the agent gets the rules of `resources/instructions-suggestions-ghost.md` and the same tools. The proposal
 *   is not in the reply text. The bridge sends it as a prompt suggestion to a client with the capability
 *   `promptSuggestion`, and the client shows it as grey text in its empty prompt input.
 * The stored suggestion state stays in each mode.
 */
export { SUGGESTION_MODES, SUGGESTIONS_VARIABLE } from './Settings.mjs'

/** The Air capability that lets the client show a prompt suggestion. */
export const PROMPT_SUGGESTION_CAPABILITY = 'promptSuggestion'
/** The version of the payload `_meta.jetbrains.air.promptSuggestion`. */
export const PROMPT_SUGGESTION_VERSION = 1
/**
 * The lifetime of a prompt suggestion: one hour, the lifetime of the default prompt cache. After that time the
 * suggestion is old, and Megachat withdraws it.
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
 * The ACP update that carries a prompt suggestion: a hidden `session_info_update` with the payload in
 * `_meta.jetbrains.air.promptSuggestion`. A client without the extension ignores it. [withdrawn] gives `text: null` with
 * the same ID, so the client removes the suggestion. This is the only place that knows the carrier.
 */
export function promptSuggestionUpdate({ id, turnId, text, expiresAt }, withdrawn = false) {
  return { sessionUpdate: 'session_info_update', _meta: { jetbrains: { air: { promptSuggestion: {
    version: PROMPT_SUGGESTION_VERSION, id, turnId, text: withdrawn ? null : text, expiresAt } } } } }
}
