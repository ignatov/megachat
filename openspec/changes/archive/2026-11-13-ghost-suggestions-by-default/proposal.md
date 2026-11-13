# Proposal

## Why

The user wants the grey text of a prompt suggestion by default. Today the setting `reply.suggestions` has the default
`off`. So a new user never sees a prompt suggestion, and the user must find the mode `ghost` in the setup or in the
settings. The setup of the first start shows the problem: Air shows no grey text for the 10 setup questions. Two causes
make this. The default `off` gives no suggestion rules and no tool `agents_suggest`. Also, in the mode `ghost`, the
rules give a suggestion only "after useful work ends" when a next step is "clearly useful", and the setup rules say
nothing about suggestions.

## What Changes

Where it shows: the prompt input of Air, as grey text after a turn, and the rules of the main agent. The reply text,
the task list of Air, the commands and the log do not change.

- **The default of `reply.suggestions` becomes `ghost`.** A user whose `settings.json` holds no value of
  `reply.suggestions` gets the mode `ghost` after the update. The main agent then gets the rules of the mode `ghost`
  and the tools `agents_suggest` and `agents_feedback`, and Air shows a next step as grey text. A stored value stays:
  a stored `off` or `reply`, and the stored `false` and `true` of v0.3.0, keep their mode. `MEGACHAT_SUGGESTIONS`
  still wins over the stored value and the default, and `MEGACHAT_SUGGESTIONS=0` gives `off`.
- **The likely answer of each setup question as grey text.** In the mode `ghost`, while the onboarding is pending, the
  main agent gets added setup rules from a new file `resources/instructions-onboarding-ghost.md`. In the turn that
  offers the setup and in each turn that ends with a setup question, the main agent calls `agents_suggest` one time
  with the likely answer, as a prompt of the user and in the language of the user. Examples: "Start the setup",
  "Keep the current values". The model writes the text. The daemon adds no fixed text. The answer keeps the current
  values, and it never turns on a setting that the setup turns on only when the user agrees. The user puts the answer
  into the input with Tab, or types another answer.
- **A next step that the user asks for goes into the reply text.** In the mode `ghost`, when the user asks for a next
  step, for example "what next?", the main agent answers in the reply text, as it answers each other question. It can
  also give a prompt suggestion after that answer. The rule "Do not propose a next step in the reply text." becomes
  "Do not propose a next step in the reply text unless the user asks for one.", so the two rules agree. A client that
  does not read `_meta.promptSuggestions` then also shows the answer.
- **The modes `off` and `reply` do not change.** In these modes, the setup has no added rules. The mode `reply` does
  not write the likely answer into the reply text, because the setup question already shows the current value and the
  default (see `design.md`).
- **The tool result of a new setup.** When the agent sets the status of the onboarding to `pending` in the mode
  `ghost`, the tool result holds the added setup rules with the setup rules, so the first question in the same turn
  gets its suggestion.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `suggestions`: the requirement "Modes of the setting reply.suggestions" changes the default to `ghost` and says what
  a stored value and the variable give. The requirement "The mode off" takes the rule text of the removed requirement
  "No next step by default", because only the mode `off` gives that rule now. Two new requirements give the setup rules
  of the mode `ghost` and the prompt suggestion of a setup question. The requirement "Rules of the mode ghost" forbids
  only a proposal that the user did not ask for, and a third new requirement, "Next step that the user asks for in the
  mode ghost", puts the answer to such a request into the reply text.
- `settings`: the requirement "List of the settings of the reply" changes the default of `reply.suggestions` in its
  scenario of the defaults to `ghost`.

## Impact

- `src/Settings.mjs`: the default of `reply.suggestions` is `ghost`. The comments of `SUGGESTIONS_VARIABLE` and
  `src/Suggestions.mjs` name the new default.
- `src/PiMegachatService.mjs`: the rules section `settings` and the tool result of the status `pending` add the rules
  of `resources/instructions-onboarding-ghost.md` in the mode `ghost` while the onboarding is pending.
- `resources/instructions-onboarding-ghost.md`: a new file with the added setup rules.
- `resources/instructions-suggestions-ghost.md`: the rule for a next step that the user asks for.
- `resources/instructions-onboarding.md` does not change in this change. Its question 6 still names `off` as the
  default. The rework of the onboarding in a later change closes that gap (see `design.md`).
- `README.md`: the table of the settings gives the default `ghost`.
- Tests: `test/suggestions.test.mjs`, `test/settings.test.mjs`, `test/upgrade.test.mjs` and
  `test/waiting-results.test.mjs` change. Each other test that needs the mode `off` sets it.
- The change does not modify an ACP extension. The prompt suggestion uses the key `_meta.promptSuggestions` of Air,
  which `docs/air-contract.md` gives, and its text does not change. Air does not change.

## Out of scope

- The text of setup question 6 and each other rework of the onboarding. A separate change reworks the onboarding.
- A migration that writes `off` into the `settings.json` of a present user. The open of a state does not change the
  file.
- A likely answer in the reply text in the mode `reply`.
- A fallback for a client that does not read `_meta.promptSuggestions`. Such a client shows no suggestion, as before.
- A change of the gate of `agents_suggest`, of the one call in each turn, of the lifetime of a prompt suggestion, or
  of the counters of the declines.
- The change touches no non-goal.
