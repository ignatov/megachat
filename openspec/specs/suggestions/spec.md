# suggestions Specification

## Purpose
Megachat can offer the user one next step after work ends. The setting `reply.suggestions` selects no offer, an offer in the reply text, or a prompt suggestion that the prompt input of the user shows.

## Requirements

### Requirement: Modes of the setting reply.suggestions
The setting `reply.suggestions` MUST have the modes `off`, `reply` and `ghost` (the default). Without a stored value, the mode MUST be `ghost`. A stored value MUST keep its mode. `MEGACHAT_SUGGESTIONS=0`, `1` and `ghost` MUST select `off`, `reply` and `ghost`, also over a stored value.

The stored values `false` and `true` of v0.3.0 MUST give `off` and `reply`, and the open MUST NOT change the file.

Tests: `test/suggestions.test.mjs`, `test/settings.test.mjs`, `test/upgrade.test.mjs`

#### Scenario: No stored value
- **WHEN** `settings.json` holds no value of `reply.suggestions` and no variable is set
- **THEN** the mode is `ghost`, the main agent has the tools `agents_suggest` and `agents_feedback`, and its rules hold "Do not propose a next step in the reply text unless the user asks for one."

#### Scenario: A stored value off
- **WHEN** `settings.json` holds the value `off` of `reply.suggestions`
- **THEN** the mode is `off`, and the rules hold "Do not propose a next step unless the user asks for one."

#### Scenario: The values of the variable
- **WHEN** `MEGACHAT_SUGGESTIONS` is `0`, `1` or `ghost`
- **THEN** the mode is `off`, `reply` or `ghost`

#### Scenario: The variable wins over a stored value
- **WHEN** `settings.json` holds the value `reply` of `reply.suggestions` and `MEGACHAT_SUGGESTIONS` is `0`
- **THEN** the mode is `off`

#### Scenario: A stored value of v0.3.0
- **WHEN** `settings.json` holds the value `true` of `reply.suggestions`, as v0.3.0 stored it
- **THEN** the mode is `reply`, and the file has the same text after the open

### Requirement: The mode off
In the mode `off`, Megachat MUST NOT offer a next step by itself. It MAY offer one when the user asks. The main agent MUST have no suggestion rules and no `agents_suggest` and `agents_feedback` tools. The stored proposal decisions MUST stay.

Tests: `test/suggestions.test.mjs`, `test/settings.test.mjs`

#### Scenario: The rules of the mode off
- **WHEN** the mode is `off`
- **THEN** the rules of the main agent hold "Do not propose a next step unless the user asks for one."

#### Scenario: The tools in the mode off
- **WHEN** the mode is `off`
- **THEN** the main agent has the tool `agents_spawn`, and it does not have the tools `agents_suggest` and `agents_feedback`

#### Scenario: The stored decisions in the mode off
- **WHEN** the mode is `off`
- **THEN** the state still holds the proposal decisions, and it can read and write them

### Requirement: The mode reply
The mode `reply` MUST give the suggestion rules of `resources/instructions-suggestions.md` and the two tools, as the value `true` did. A daemon restart applies a changed value.

Tests: `test/suggestions.test.mjs`, `test/settings.test.mjs`

#### Scenario: The rules and the tools of the mode reply
- **WHEN** the mode is `reply`
- **THEN** the main agent has the tools `agents_suggest` and `agents_feedback`, and its rules hold "Call agents_suggest before every proposal"

#### Scenario: A proposal in the reply text
- **WHEN** the mode is `reply` and the main agent proposes "Run the tests?" through `agents_suggest`
- **THEN** the reply text holds "Done. Run the tests?", and Megachat sends no prompt suggestion

### Requirement: Rules of the mode ghost
The mode `ghost` MUST give the rules of `resources/instructions-suggestions-ghost.md` and the two tools. The rules MUST forbid a proposal in the reply text that the user did not ask for. They MUST ask for at most one call of `agents_suggest` in a turn, with one short prompt in the voice and the language of the user, and for no call when no next step is clearly useful.

Tests: `test/suggestions.test.mjs`

#### Scenario: The rules of the mode ghost
- **WHEN** the mode is `ghost`
- **THEN** the rules of the main agent hold "Do not propose a next step in the reply text unless the user asks for one." and "Write the suggestion as a prompt of the user"

### Requirement: Next step that the user asks for in the mode ghost
In the mode `ghost`, when the user asks for a next step, the rules MUST ask for the answer in the reply text, as for each other question. A prompt suggestion MAY follow the answer.

Tests: `test/suggestions.test.mjs`

#### Scenario: A request for a next step
- **WHEN** the mode is `ghost`
- **THEN** the rules of the main agent hold "When the user asks for a next step, such as \"what next?\", answer in the reply text." and "You can also give a suggestion after that answer."

### Requirement: Gate of agents_suggest in the mode ghost
In the mode `ghost`, `agents_suggest` MUST keep the gate of the mode `reply`: no silence, fewer than three declines, and no live prompt suggestion. A proposal of the mode `reply` that waits for its feedback MUST NOT stop it. The text MUST become one line.

Tests: `test/suggestions.test.mjs`

#### Scenario: A waiting proposal of the mode reply
- **WHEN** the state holds the proposal "Add a test for the parser." of the mode `reply`, which waits for its feedback, and the main agent calls `agents_suggest` with "Run the tests"
- **THEN** the prompt suggestion is "Run the tests"

#### Scenario: A text of two lines
- **WHEN** the main agent calls `agents_suggest` with the text "Run the tests" and "and fix the failures" on two lines
- **THEN** the prompt suggestion is "Run the tests and fix the failures"

### Requirement: Prompt suggestion of the turn
The allowed text MUST become the prompt suggestion of the turn, and the tool result MUST tell the agent not to repeat it in the reply. A second call in the same turn MUST get `allowed=false` and change nothing.

Tests: `test/suggestions.test.mjs`

#### Scenario: The tool result of an allowed text
- **WHEN** the main agent calls `agents_suggest` with "Run the tests"
- **THEN** the tool result has `allowed: true` and the note "The prompt input of the user shows this text after the turn. Do not write it, or a note about it, in the reply."

#### Scenario: A second call in one turn
- **WHEN** the main agent calls `agents_suggest` with "Run the tests" and then with "Commit the change" in the same turn
- **THEN** the second call gets `allowed=false`, and the prompt suggestion stays "Run the tests"

### Requirement: End of the turn after the reply in the mode ghost
In the mode `ghost`, a model message of the main agent with reply text and a call of `agents_suggest` or `agents_feedback` MUST end the turn when each of its calls succeeds and is `agents_suggest`, `agents_feedback`, or `agents_settings` with the action `set` or `reset`. Then Air shows the reply as one open message, not in a closed block "Worked for". The rules MUST ask for the call after the full reply text.

Tests: `test/suggestions.test.mjs`

#### Scenario: A setup question with its suggestion
- **WHEN** the mode is `ghost`, and the main agent writes a setup question and calls `agents_suggest` with "Opus + Claude" in the same message
- **THEN** the turn makes one model request and ends with `end_turn`, the view gets the reply as chunks of one message ID, and then the prompt suggestion "Opus + Claude"

#### Scenario: An answer, a question and a suggestion in one message
- **WHEN** the mode is `ghost`, and the main agent writes a setup question, calls `agents_settings(action="set")` with a valid value and calls `agents_suggest`, in one message
- **THEN** the turn makes one model request

#### Scenario: A message that the model must continue
- **WHEN** the mode is `ghost`, and the message of the reply text and `agents_suggest` also calls `agents_list`, or a call of `agents_settings` fails or reads the settings
- **THEN** the turn makes a second model request

#### Scenario: The mode reply
- **WHEN** the mode is `reply`, and the main agent writes reply text and calls `agents_suggest` in the same message
- **THEN** the turn makes a second model request

### Requirement: Reply after a suggestion without reply text in the mode ghost
In the mode `ghost`, when the main agent calls `agents_suggest` before each reply text of the turn, the tool result MUST tell the agent that the user saw no reply text, and that it must write the full reply now in one message without a tool call. While the setup is pending, the result MUST also ask for the full setup question with its numbered options, the current value and the default. A reply text earlier in the turn MUST give no such note.

Tests: `test/suggestions.test.mjs`

#### Scenario: A setup turn that calls agents_suggest first
- **WHEN** the setup is pending, and the main agent sets the status `pending`, reads the settings and calls `agents_suggest` with "Opus + Claude" before each reply text
- **THEN** the tool result holds the note `suggest.ghost.reply.setup`, the next reply is the only message of the turn, and the view gets the prompt suggestion "Opus + Claude"

#### Scenario: A reply text earlier in the turn
- **WHEN** the main agent writes a text with a call of `agents_list`, and then calls `agents_suggest` in a message without text
- **THEN** the tool result has no note about the reply

### Requirement: Turns without a prompt suggestion
A turn that admits a child task is a delegation acknowledgment. It MUST get no prompt suggestion, also when the main agent admits the child after the proposal. A turn that the user stopped or that failed MUST keep no prompt suggestion.

Tests: `test/suggestions.test.mjs`

#### Scenario: A proposal after the admission of a child
- **WHEN** the main agent admits a child task with `agents_spawn` and then calls `agents_suggest` in the same turn
- **THEN** the call gets `allowed=false`

#### Scenario: A proposal before the admission of a child
- **WHEN** the main agent calls `agents_suggest` and then admits a child task in the same turn
- **THEN** the turn sends no prompt suggestion

#### Scenario: A stopped turn
- **WHEN** the user sends `session/cancel` after the call of `agents_suggest` and before the end of the turn
- **THEN** the turn ends with `cancelled`, and Megachat keeps and sends no prompt suggestion

### Requirement: Prompt suggestion of an automatic turn
A turn of a child result or of the summary of the past sessions MUST send a prompt suggestion only when the main agent calls `agents_suggest`. The rules MUST allow that only when the result leaves a clear next action for the user.

Tests: `test/suggestions.test.mjs`

#### Scenario: A plain report
- **WHEN** a turn of the summary of the past sessions replies "Megachat indexed 2 sessions." and does not call `agents_suggest`
- **THEN** the turn sends no prompt suggestion, and its rules hold "give a suggestion only when the result leaves a clear next action for the user"

#### Scenario: A report with a clear next action
- **WHEN** a turn of the summary of the past sessions calls `agents_suggest` with "Resume the parser session"
- **THEN** the view gets the prompt suggestion "Resume the parser session"

### Requirement: Carrier of the prompt suggestion
In the mode `ghost`, Megachat MUST send the prompt suggestion to each client, without a capability. The carrier MUST be the key of Air `_meta.promptSuggestions` of a `session_info_update` without a title, with `{ "suggestions": [{ "text": ... }] }`, as `docs/air-contract.md` gives it. No client may get the proposal in the reply text. The mode `ghost` MUST NOT fall back to the mode `reply`.

Tests: `test/suggestions.test.mjs`

#### Scenario: The update of a prompt suggestion
- **WHEN** the allowed text of a turn is "Run the tests and fix the failures"
- **THEN** the client gets `{ "sessionUpdate": "session_info_update", "_meta": { "promptSuggestions": { "suggestions": [{ "text": "Run the tests and fix the failures" }] } } }`

#### Scenario: Clients without a capability
- **WHEN** an Air client with the capability `asyncTasks` and a plain ACP client show the conversation, and a turn suggests "Run the tests"
- **THEN** each client gets the prompt suggestion "Run the tests", and no `agent_message_chunk` holds that text

### Requirement: Send of the prompt suggestion
The bridge MUST send the prompt suggestion after the last `agent_message_chunk` of its turn and before the end of the turn. The wire MUST have no ID, no turn and no expiry time. The daemon MUST keep them.

Tests: `test/suggestions.test.mjs`

#### Scenario: The time of the send
- **WHEN** a turn has the prompt suggestion "Run the tests and fix the failures"
- **THEN** the client gets the update after the last `agent_message_chunk` and before the end of the turn, and the update has no ID, no turn and no expiry time

#### Scenario: The data that the daemon keeps
- **WHEN** a turn with the client message ID `turn-1` sends a prompt suggestion
- **THEN** the state of the daemon keeps the ID of the suggestion, the turn `turn-1` and the expiry time

### Requirement: End of a prompt suggestion
A prompt suggestion MUST end at the start of the next turn, of the user or automatic, at a `session/cancel` while no turn runs, and at its `expiresAt`. The lifetime is `PROMPT_SUGGESTION_LIFETIME_MS` of `src/Suggestions.mjs`: one hour, the lifetime of the default prompt cache. A sent suggestion that ends MUST get a withdrawal: the same update with an empty list.

Tests: `test/suggestions.test.mjs`

#### Scenario: The next turn
- **WHEN** the prompt suggestion "Run the tests" is live and the user sends the prompt "Hello"
- **THEN** the view gets a `session_info_update` with `{ "suggestions": [] }`

#### Scenario: A cancel while no turn runs
- **WHEN** a prompt suggestion is live, no turn runs, and a client sends `session/cancel`
- **THEN** each view gets the withdrawal, and the state holds no prompt suggestion

#### Scenario: The expiry
- **WHEN** a turn sends a prompt suggestion
- **THEN** its `expiresAt` is one hour after the turn, and at that time each view gets the withdrawal

### Requirement: Prompt suggestion after a change of the mode
A view MUST send a stored prompt suggestion only in the mode `ghost`. A change of the mode to `reply` or `off` MUST end the suggestion: at once while no turn runs, else at the end of the turn before a view shows it. A daemon that starts in the mode `reply` or `off` MUST end a stored suggestion.

Tests: `test/suggestions.test.mjs`

#### Scenario: A change of the mode while no turn runs
- **WHEN** the prompt suggestion "Run the tests" is live, no turn runs, and the mode changes from `ghost` to `reply`
- **THEN** the view gets the withdrawal at once, and a view that sends `session/load` after the change gets no prompt suggestion

#### Scenario: A change of the mode back to ghost
- **WHEN** the mode changes from `ghost` to `reply` and then back to `ghost`
- **THEN** no view gets the old suggestion "Run the tests" again

#### Scenario: A change of the mode in the turn of the suggestion
- **WHEN** the main agent calls `agents_suggest` with "Run the tests", and in the same turn `agents_settings` sets `reply.suggestions` to `reply`
- **THEN** the view gets no prompt suggestion, and the state holds no prompt suggestion

#### Scenario: A start in the mode reply
- **WHEN** the state holds the prompt suggestion "Commit the change" of the mode `ghost`, and the daemon starts in the mode `reply`
- **THEN** the state holds no prompt suggestion

### Requirement: Prompt suggestion after session/load and session/new
`session/load` and `session/new` MUST send a live prompt suggestion again after the replay and the title. They MUST send no old suggestion.

Tests: `test/suggestions.test.mjs`

#### Scenario: A live suggestion
- **WHEN** the prompt suggestion "Run the tests" is live and a new view sends `session/load`
- **THEN** the view gets the prompt suggestion "Run the tests" after the replay and the title

#### Scenario: An old suggestion
- **WHEN** the state holds a prompt suggestion whose `expiresAt` is in the past, and a view sends `session/load`
- **THEN** the view gets no prompt suggestion

### Requirement: Ignored prompt suggestions
Each prompt of the user while a suggestion is live MUST record `ignored`, also a prompt with the text of the suggestion, because the client reports no accept. `ignored` MUST change no counter.

Tests: `test/suggestions.test.mjs`

#### Scenario: Another prompt
- **WHEN** a prompt suggestion is live, the count of the declines is 2, and the user sends the prompt "Hello"
- **THEN** Megachat records `ignored` for that prompt, and the count of the declines stays 2

#### Scenario: A prompt with the text of the suggestion
- **WHEN** the prompt suggestion "Commit the change" is live and the user sends the prompt "Commit the change"
- **THEN** Megachat records `ignored` for that prompt

### Requirement: Silence of the prompt suggestions
`agents_feedback(decision="silence")` MUST stop each later prompt suggestion. The suggestion of the turn before ends at the start of the turn.

Tests: `test/suggestions.test.mjs`

#### Scenario: A call for silence
- **WHEN** the main agent calls `agents_feedback(decision="silence")` and then calls `agents_suggest` with "Push the change"
- **THEN** the call gets `allowed=false`, and the later turns send no prompt suggestion

### Requirement: A prompt suggestion is not permission
A prompt suggestion is not permission. Megachat MUST start the work only when the prompt of the user arrives.

#### Scenario: A shown suggestion
- **WHEN** the prompt input of the user shows the prompt suggestion "Run the tests"
- **THEN** Megachat starts no work until the prompt of the user arrives

### Requirement: Proposals after work ends
In the modes `reply` and `ghost`, Megachat MAY offer one useful next step after work ends. After a refusal, it MAY then offer two alternatives. After the third refusal, it MUST stop proposing work.

Tests: `test/state.test.mjs`, `test/integration.test.mjs`

#### Scenario: A proposal after a turn of the summary of the past sessions
- **WHEN** the mode is `reply` and the turn of the summary of the past sessions proposes "Resume the parser session?" through `agents_suggest`
- **THEN** the view gets the reply "Resume the parser session?"

#### Scenario: Three refusals
- **WHEN** the user refused three proposals
- **THEN** the next call of `agents_suggest` gets `allowed=false`

### Requirement: Request for silence
A direct request for silence MUST suppress proposals until the user asks to resume.

Tests: `test/state.test.mjs`

#### Scenario: Silence and resume
- **WHEN** the user asks for silence and then gives a new task
- **THEN** a proposal gets `allowed=false`, and after the decision `resume` a proposal gets `allowed=true`

### Requirement: Durable proposal decisions
Proposal decisions MUST survive a daemon restart.

Tests: `test/state.test.mjs`

#### Scenario: Three refusals and a restart
- **WHEN** the user refused three proposals and the daemon restarts
- **THEN** the next proposal gets `allowed=false`

### Requirement: Proposal after the third refusal
After the third refusal, only an accepted proposal, a new task of the user (`accepted`) or `resume` MAY permit another proposal. An automatic turn MUST NOT reset the count of the refusals.

Tests: `test/state.test.mjs`

#### Scenario: An automatic turn after three refusals
- **WHEN** the user refused three proposals and a turn of the summary of the past sessions starts
- **THEN** the proposal "Review the sessions" gets `allowed=false`

#### Scenario: A new task after three refusals
- **WHEN** the user refused three proposals and then gives a new task (`accepted`)
- **THEN** the proposal "Review the sessions" gets `allowed=true`

### Requirement: Setup rules of the mode ghost
In the mode `ghost`, while the onboarding is pending, the rules of the main agent MUST hold the rules of `resources/instructions-onboarding-ghost.md` after the setup rules (see the capability `settings`). The tool result of the status `pending` MUST hold them too. In the modes `off` and `reply`, and after the status `done` or `skipped`, the rules MUST NOT hold them.

Tests: `test/suggestions.test.mjs`

#### Scenario: A first start
- **WHEN** the state directory has no `settings.json` and no variable is set
- **THEN** the rules hold "The setup of Megachat is pending." and "While a setup question waits for an answer, give the likely answer as a prompt suggestion."

#### Scenario: A pending onboarding in the mode reply
- **WHEN** the onboarding is pending and the mode is `reply`
- **THEN** the rules hold "The setup of Megachat is pending.", and they do not hold "While a setup question waits for an answer"

#### Scenario: The end of the setup
- **WHEN** the mode is `ghost` and the agent sets the status of the onboarding to `done`
- **THEN** the next turn has no rule "While a setup question waits for an answer"

#### Scenario: A new setup
- **WHEN** the mode is `ghost` and the agent sets the status of the onboarding to `pending`
- **THEN** the tool result holds "The setup of Megachat is pending." and "While a setup question waits for an answer"

### Requirement: Prompt suggestion of a setup question
The added setup rules MUST ask for one call of `agents_suggest` in the reply that offers the setup and in each reply that ends with a setup question. The text MUST be the likely answer as a prompt of the user, in the language of the user. It MUST keep the current values: for the pair of agents, the current pair. It MUST NOT turn on a setting that the setup turns on only when the user agrees. The gate of `agents_suggest` MUST stay as in each other turn.

Tests: `test/suggestions.test.mjs`

#### Scenario: The text of the rules
- **WHEN** a test reads `resources/instructions-onboarding-ghost.md`
- **THEN** it holds "call agents_suggest one time with the likely answer", "Keep the current values" and "For the pair of agents, the likely answer is the current pair", and it names no setting key

#### Scenario: A setup question
- **WHEN** the onboarding is pending, the mode is `ghost`, and the main agent replies "Which agents do you want: Opus + Claude, or Opus + Codex on GPT-6 Astra? Now it is Opus + Claude." and calls `agents_suggest` with "Opus + Claude"
- **THEN** the view gets the prompt suggestion "Opus + Claude", and no `agent_message_chunk` holds only that text

#### Scenario: A setup question after a request for silence
- **WHEN** the onboarding is pending, the mode is `ghost`, the main agent called `agents_feedback(decision="silence")`, and a later setup turn calls `agents_suggest` with "Keep the current values"
- **THEN** the call gets `allowed=false`, and the turn sends no prompt suggestion
