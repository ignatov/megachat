/**
 * `MEGACHAT_SUGGESTIONS=1` lets the main agent offer a next step by itself. Then the agent gets the suggestion rules
 * and the tools `agents_suggest` and `agents_feedback`. Without the variable, the agent offers a next step only when
 * the user asks for one. The stored suggestion state stays in the two cases.
 */
export const SUGGESTIONS_VARIABLE = 'MEGACHAT_SUGGESTIONS'

export function suggestionsEnabled(environment = process.env) {
  return environment[SUGGESTIONS_VARIABLE]?.trim() === '1'
}
