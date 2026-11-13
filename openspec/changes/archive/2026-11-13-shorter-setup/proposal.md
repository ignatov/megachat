# Proposal

## Why

The setup of the first start has 10 questions, and many of them ask for a setting that a new user cannot judge yet,
such as the parallel child tasks, the permissions of a child, the prompt cache or the working hours. The user wants a
short setup with three questions. The other settings keep their defaults, and the main agent offers such a setting
later, one time, when a report shows that it helps: "tune it as we go, when the summaries come".

## What Changes

Where it shows: the chat (the setup and the reports of the main agent) and the prompt input of Air (grey text in the
mode `ghost`). The task list of Air, the commands and the log do not change.

- **The setup has three questions.** The setup rules of `resources/instructions-onboarding.md` ask only these:
  1. The agents, as a choice of two pairs with the current main model: for example "Opus + Claude"
     (`children.agent` `claude`) or "Opus + Codex on GPT-6 Astra" (`children.agent` `codex`,
     `children.codexModel` `openai/gpt-6-astra`). The question changes only the children. The main model keeps its
     value: Opus by default, or another model that the user chose, such as Fable. The setup does not ask for the
     reasoning level, which keeps its value, and it shows no prices.
  2. The index of past sessions, `sessions.index`, with the present question of consent. It is on only when the user
     agrees. The setup no longer asks for `sessions.notes`.
  3. The known repositories: `discover`, then `add` of each repository that the user chooses. The setup no longer asks
     for `projects.newRoot`.
  At the end, the account check runs as no question. The agent shows only the agents with a problem and what to fix,
  and it says nothing about the check when each agent is ready. The closing text says that each setting can change
  later in the chat.
- **The other settings leave the setup.** The old questions 5 to 9, `children.parallel`, the models of the children,
  the reply style, `reply.suggestions`, the prompt cache, the summary, the learned memory, the working day, the morning
  report, `update.auto` and `budget.dailyUsd` keep their defaults. The old question 6 goes away, so its stale text
  "off, the default" goes away too.
- **Contextual offers of a setting.** In the modes `reply` and `ghost` of `reply.suggestions`, after the setup, the
  main agent offers a setting that left the setup when a report or a tool result shows that the setting helps. Example:
  a child result says that a push is necessary, and the agent offers `children.push`. The offer is one sentence in the
  reply text with the current value. In the mode `ghost`, the agent can also give the acceptance as grey text. A new
  file, `resources/instructions-offers.md`, holds the offer rules and the list of the settings with their triggers.
- **One offer for each setting, durable.** The agent calls `agents_settings(action="offer", key)` before an offer. The
  daemon records each allowed offer in the conversation state, next to the proposal decisions. So a restart and a
  compaction keep it, and a second offer of the same setting gets `allowed=false`. A setting with a stored value or a
  variable gets no offer.
- **The grey text of the setup fits the three questions.** In `resources/instructions-onboarding-ghost.md`, the likely
  answer of the choice of the agents is the current pair, for example "Opus + Claude".
- **A present user does not see the setup again.** The status `done` or `skipped` keeps the setup away, as today. A
  state with the status `pending` gets the three questions.

## Capabilities

### New Capabilities

- `setting-offers`: the list of the settings that the main agent can offer with their triggers, the offer rules in the
  rules of the main agent, the record of an offer and its gate, and the text of an offer.

### Modified Capabilities

- `settings`: "Content of the setup rules" gives the three questions. "End of the onboarding" changes the rule "only
  when the user asks" so that it allows an offer. "Change of a setting" names the action `offer`. "No change from an
  automatic turn" lets the record of an offer work in an automatic turn.
- `child-settings`: "Parallel runs in the rules" no longer asks for `children.parallel` in the setup.
- `session-notes`: "Rules and setup of the notes" moves `sessions.notes` from the setup to the offers.
- `accounts`: "When the check runs" shows only the problems at the end of the setup.
- `morning-report`: "Tools of the report turn" allows the record of an offer.
- `suggestions`: "Prompt suggestion of a setup question" gives the current pair as the likely answer of the choice of
  the agents.

## Impact

- `resources/instructions-onboarding.md`: the three questions, the account check and the closing text.
- `resources/instructions-onboarding-ghost.md`: the likely answer of the choice of the agents.
- `resources/instructions-offers.md`: a new file with the offer rules and the list of the offers.
- `resources/Megachat.properties`: the text of `instructions.settings`, the description of `agents_settings`, and the
  heading line of the open offers.
- `src/PiMegachatService.mjs`: the action `offer` of `agents_settings`, and the offer rules in the rules section
  `settings`.
- `src/MegachatState.mjs`: the field `initiative.offers` and the record of an offer.
- `README.md`: the setup, the offers, and the account check at the end of the setup.
- Tests: `test/settings.test.mjs`, `test/session-notes.test.mjs`, `test/session-index.test.mjs`,
  `test/suggestions.test.mjs`, `test/morning-report.test.mjs`, and a new `test/setting-offers.test.mjs`.
- The change does not modify an ACP extension. An offer is a usual `agent_message_chunk`, and its grey text uses the
  present key `_meta.promptSuggestions`. Air does not change, and `docs/air-contract.md` does not change.

## Out of scope

- A main agent on GPT-6 Astra or on another OpenAI model. The main agent runs only on the Anthropic provider of
  JetBrains Central (`CentralConfigurationService.models()`). A later change can add an OpenAI provider.
- Offers in the mode `off` of `reply.suggestions`.
- Offers of `update.auto`, `projects.newRoot`, the models of the children, the reply style, the prompt cache, the
  summary and the learned memory.
- A fact of the keep-alive cost at night in a report. No report gives it today (see `design.md`).
- A change of the account check itself, of the index question of consent, or of the discovery of repositories.
- The change touches no non-goal.
