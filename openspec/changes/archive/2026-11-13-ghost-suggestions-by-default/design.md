# Design

## Context

See `proposal.md` for the reason. The facts below come from the code at c5d77c8.

- The registry of the settings gives `reply.suggestions` the default `off` (`src/Settings.mjs:214`), with the modes
  `SUGGESTION_MODES` `off`, `reply` and `ghost`. `fromEnvironment` reads `MEGACHAT_SUGGESTIONS`: `0` gives `off`, `1`
  gives `reply`, and a mode name gives that mode. `suggestionMode` takes the stored `false` and `true` of v0.3.0 as
  `off` and `reply`.
- The effective value is the explicit option of a caller, then the variable, then the project value, then the stored
  value, then the default (`MegachatSettings.entry`, `src/Settings.mjs:435-442`). A stored value that this build does
  not accept gives the default.
- `agents_settings set` stores each valid value as given, also a value that is equal to the default
  (`MegachatSettings.set`). `reset` removes the stored value. A setup question that the user skips stores nothing:
  the setup rules say "Then keep the current values".
- `settingsRules` (`src/PiMegachatService.mjs:97`) makes the rules section `settings`. In the mode `off` it adds
  `instructions.noSuggestions`, in `reply` the file `resources/instructions-suggestions.md`, and in `ghost` the file
  `resources/instructions-suggestions-ghost.md`. Later in the same section, a pending onboarding adds
  `resources/instructions-onboarding.md`.
- `agents_settings(action="onboarding", status="pending")` puts `rules.onboarding` into the tool result
  (`src/PiMegachatService.mjs:393`), so the setup can start in the same turn.
- The rules of the mode `ghost` say "After useful work ends, you may give the user one next step", "call agents_suggest
  one time in the turn", and "If no next step is clearly useful, call nothing". The setup rules say nothing about a
  suggestion. So a setup question gets no grey text, also in the mode `ghost`.
- The mode also selects the prompts of the automatic turns: `event.children.suggest` and `event.sessions.suggest` in
  the modes `reply` and `ghost`, `event.children` and `event.sessions` in the mode `off`
  (`MegachatState.eventSuffix`).

## Goals / Non-Goals

**Goals:**

- Each user without a stored value of `reply.suggestions` gets the mode `ghost`.
- In the mode `ghost`, Air shows the likely answer of each setup question as grey text.
- A user with a stored value, or with `MEGACHAT_SUGGESTIONS`, keeps the mode.

**Non-Goals:**

- A rework of the onboarding, also of question 6 (see "Known gaps").
- A change of the mode `reply` or of the mode `off`.
- A change of the gate of `agents_suggest`, of the carrier, or of the lifetime of a prompt suggestion.

## Decisions

### 1. The default changes in the registry, and no migration writes a value

The default of `reply.suggestions` in `src/Settings.mjs` becomes `ghost`. Nothing else selects the default, so
`suggestionsMode`, the rules, the tools and the event prompts follow it.

The result for each state directory:

| `settings.json` | `MEGACHAT_SUGGESTIONS` | Mode before | Mode after |
| --- | --- | --- | --- |
| No file, or no value of `reply.suggestions` | not set | `off` | `ghost` |
| `"off"` or `false` (v0.3.0) | not set | `off` | `off` |
| `"reply"` or `true` (v0.3.0) | not set | `reply` | `reply` |
| `"ghost"` | not set | `ghost` | `ghost` |
| A value that this build does not accept, such as `"grey"` | not set | `off` | `ghost` |
| Any | `0`, `1` or `ghost` | `off`, `reply` or `ghost` | the same |

A present user who did the setup and kept the default at question 6 usually has no stored value, because a skipped or
kept question stores nothing. That user also gets `ghost`. This is the intent of the change. A user who wants `off`
sets it in the chat, or sets `MEGACHAT_SUGGESTIONS=0`.

Alternative: write `off` into each present `settings.json` at the first open of the new build. Refused: the user asks
for grey text by default, and the open of a state does not change the file (see the requirement "Modes of the setting
reply.suggestions" and the capability `compatibility`).

### 2. A new rules file for the setup in the mode ghost

The added setup rules go into a new file `resources/instructions-onboarding-ghost.md`. `settingsRules` adds it after
`resources/instructions-onboarding.md` only when the onboarding is pending and the mode is `ghost`. The tool result of
the status `pending` adds it after `rules.onboarding` under the same condition.

The proposed text of the file:

```
While a setup question waits for an answer, give the likely answer as a prompt suggestion. A setup question is a clear next step.
In the reply that offers the setup, and in each reply that ends with a setup question, call agents_suggest one time with the likely answer. This is the one suggestion of the turn.
Write the answer as a prompt of the user, in the language of the user, for example "Start the setup" or "Keep the current values". You can name the current values in a few words.
The likely answer keeps the current values of the question. When the question lets the user choose from a list, such as the found repositories, the answer can choose each item of the list.
Do not give an answer that turns on a setting that the setup turns on only when the user agrees.
A reply that asks no setup question, such as the account check at the end, follows the usual suggestion rules.
```

The file names no setting key, so the test "the setup rules name each setting of this build and no other setting"
stays true for `resources/instructions-onboarding.md` alone.

Why not the other files:

- `resources/instructions-onboarding.md` applies in each mode. A rule that names `agents_suggest` would name a tool
  that the mode `off` does not have, and the rule would need a condition on the mode in the text. The user also
  reworks this file in a later change, so this change keeps it as it is.
- `resources/instructions-suggestions-ghost.md` applies also after the setup. A rule for the setup would stay in each
  request after the setup ends.

How the rules fit together:

- One call in each turn: the setup asks one question in each reply, so each turn has at most one likely answer. In
  the reply that offers the setup, the main agent first answers the message of the user. The rules make the start of
  the setup the one suggestion of that turn, also when the answer has another next step.
- "If no next step is clearly useful, call nothing": the added rules say that a setup question is a clear next step.
- The gate of `agents_suggest` does not change. A request for silence, three declines, or a live prompt suggestion
  stops a setup suggestion as it stops each other suggestion. In the mode `ghost`, an ignored suggestion changes no
  counter, so a different answer of the user does not stop the later suggestions.
- The opt-in questions (`sessions.index`, `sessions.notes`, `workday.enabled`, `report.morning`, `update.auto`) set a
  value only when the user agrees. A likely answer that keeps the current values never turns them on.
- The model writes each text in the language of the user. The daemon adds no fixed text, so
  `resources/Megachat.properties` gets no new string.
- When the user changes `reply.suggestions` in the setup, the change applies at the end of the turn, as today. After
  a change to `off` or `reply`, the later questions get no added rules.

### 3. The mode reply does not change

In the mode `reply`, the setup gets no added rules, and the reply text gets no likely answer. Reasons:

- Each setup question already shows the current value and the default in the reply text. A likely answer in the same
  text adds nothing.
- In the mode `reply`, each proposal goes through `agents_suggest` and waits for its feedback. The rules tell the agent
  to record a refusal with `agents_feedback(decision="declined")`, so an answer that is not the proposal can count as
  a decline. Three such setup answers would then stop each proposal after the setup.

### 4. Clients other than Air

The carrier stays the key `_meta.promptSuggestions` of a `session_info_update` without a title
(`promptSuggestionUpdate` in `src/Suggestions.mjs`). A client that does not read the key ignores it by the rules of
ACP, and shows no suggestion. In the mode `ghost`, the rules forbid a proposal in the reply text that the user did not
ask for, so such a client shows no next step that the agent offers by itself. A next step that the user asks for goes
into the reply text (decision 5), and each client shows it. Before this change, the default `off` also gave such a
client no next step. So the default `ghost` loses no proactive offer for such a client. `docs/air-contract.md` gives
the carrier, and it names no default of `reply.suggestions`, so it needs no change.

### 5. A next step that the user asks for

In the mode `off`, the agent offers a next step in the reply text when the user asks for one. The rules of the mode
`ghost` said "Do not propose a next step in the reply text." without an exception. So with the new default, a user who
asks "what next?" could get the answer only as grey text, and a client that does not read `_meta.promptSuggestions`
would show no answer. The rules of the mode `ghost` change:

```
Do not propose a next step in the reply text unless the user asks for one. Do not mention the suggestion in the reply.
When the user asks for a next step, such as "what next?", answer in the reply text. You can also give a suggestion after that answer.
```

The first line keeps the ban for a next step that the agent offers by itself, so the two lines agree. The rule needs
no change of the code: the carrier, the gate and the one call in each turn stay. A question of the setup is no request
for a next step, so decision 2 does not change.

### 6. The daemon, the state and the ACP messages

- A disconnect of the ACP client and a restart: the change adds no work and no state. The daemon reads the mode at
  the start and at each change of the setting, as today. The first start of the new build applies the new default.
  A live prompt suggestion stays in `initiative.promptSuggestion` of the conversation state, as today.
- `settings.json`: the change reads `values["reply.suggestions"]` and `onboarding`, as today, and adds no field. An
  older state directory without the value gets `ghost`. `conversation.sqlite` gets no new field.
- ACP: the change adds no message and no `_meta` key. It sends more `session_info_update` messages with
  `_meta.promptSuggestions`, because more users have the mode `ghost`.

## Risks / Trade-offs

- [More prompt tokens for each user without a stored value] The rules of the mode `ghost` and the two tools go into
  each request. The update gives one miss of the prompt cache for the section `settings` and the tools. Mitigation:
  none needed. The section is its own block, and later requests use the cache.
- [The event prompts change] A turn of a child result or of the summary of the past sessions gets the prompt
  `event.children.suggest` or `event.sessions.suggest`, which allows one next step through `agents_suggest`.
  Mitigation: the rules allow that only when the result leaves a clear next action.
- [A client without `_meta.promptSuggestions`] It shows no next step that the agent offers by itself, as with the
  default `off` (decision 4). It shows a next step that the user asks for (decision 5).
- [Old declines] A state with three declines of the mode `reply` gives no setup suggestion until an accepted proposal,
  a new task or `resume`. This is the gate as it is.
- [Tests that rely on the default `off`] Each test that checks the mode `off` without a stored value fails. The tasks
  set the mode `off` in these tests.

## Known gaps

- Setup question 6 in `resources/instructions-onboarding.md` still says "reply.suggestions: off, the default, gives no
  offer". After this change that text is stale: the default is `ghost`. The agent reads the current value and the
  default from `agents_settings get`, but the text can still make it say the wrong default. The rework of the
  onboarding in a later change closes this gap, and question 6 will likely go away.

## Open Questions

None.
