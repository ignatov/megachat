import { environmentSetting } from './Settings.mjs'

/**
 * `MEGACHAT_SUGGESTIONS=1` or the setting `reply.suggestions` lets the main agent offer a next step by itself. Then the
 * agent gets the suggestion rules and the tools `agents_suggest` and `agents_feedback`. Without them, the agent offers
 * a next step only when the user asks for one. The stored suggestion state stays in the two cases.
 */
export { SUGGESTIONS_VARIABLE } from './Settings.mjs'

/** The suggestions from the environment alone, without the stored settings. */
export function suggestionsEnabled(environment = process.env) {
  return environmentSetting('reply.suggestions', environment)
}
