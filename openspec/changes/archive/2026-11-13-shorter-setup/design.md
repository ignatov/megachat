# Design

## Context

See `proposal.md` for the reason. The facts below come from the code at 6b7c17b.

- `resources/instructions-onboarding.md` asks 10 questions. The rules section `settings` adds it while the onboarding
  is `pending` (`settingsRules` in `src/PiMegachatService.mjs`). In the mode `ghost`, the file
  `resources/instructions-onboarding-ghost.md` follows it.
- `settings.json` holds the status of the onboarding (`pending`, `done` or `skipped`). After `done` or `skipped`, the
  setup rules do not come back by themselves (the requirement "End of the onboarding"). The rules then hold
  `instructions.settings`: "Read or change a setting of Megachat with agents_settings only when the user asks."
- The proposal decisions are in the conversation state, in `initiative` of the document of Megachat in
  `conversation.sqlite`: `declines`, `silenced`, `suggestion`, `promptSuggestion` and `decisions`.
  `MegachatState.initiativeDecision(requestId, args, apply)` records each decision under the ID of its tool call, so
  a tool call that runs again after a crash gets the same result. `decisions` drops its oldest half at 2000 entries.
- An older build opens a `settings.json` with an unknown top-level key and writes the key back (`invalidReason` checks
  only `schema`, `onboarding` and `values`, and the store writes a copy of the whole object).
- A turn of a child result and a turn of the summary of the past sessions refuse a change of a setting. The turn of
  the morning report refuses each tool that starts or changes something.
- The main agent has no clock in its prompt. The spend of the day (`DailySpend`) has no part for the keep-alive
  requests. `report.morning` is off by default, so most users get no morning report.
- A session note is a fixed text of the daemon. It makes no model request, so the main agent writes nothing into a
  note.

### The check of `children.codexModel` and GPT-6 Astra

- The validation accepts `openai/gpt-6-astra`. `codexModel` in `src/Settings.mjs` takes `inherit`, or a text that
  starts with `openai/` with a model ID that matches `CODEX_MODEL_ID` (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/`).
  `gpt-6-astra` matches. The registry need not know the model.
- The model registry of Megachat does not know the model. `CentralConfigurationService.models()` registers only the
  provider `anthropic`, with 18 models. So `agents_settings get` lists no price of GPT-6 Astra.
- The data of pi-ai knows the model. `providers/data/openai.json` and `providers/data/openai-codex.json` have "GPT-6
  Astra" (`gpt-6-astra`), with 10 USD input and 50 USD output for each million tokens, and a context of 272,000
  tokens. Megachat does not register these providers.
- Codex decides at the run. The Codex adapter refuses a model that is not in its model list, and the task then fails
  before its prompt (`error.childCodexModel`). The local configuration of Codex of the author already has
  `model = 'gpt-6-astra'`, so `inherit` gives the same model on this machine.

## Goals / Non-Goals

**Goals:**

- A setup of three questions, with the account check at the end as no question.
- The other settings keep their defaults. The main agent offers each of them at most one time, when a report shows
  that it helps.
- A present user with the status `done` or `skipped` sees no setup.

**Non-Goals:**

- A main agent on an OpenAI model.
- A new fact in a report, such as the keep-alive cost at night.
- Offers in the mode `off`.

## Decisions

### 1. The text of the setup rules

`resources/instructions-onboarding.md` gets this text. The lines before "The questions of the setup:" keep their
rules, with two changes: the offer says that the setup has three questions, and an answer that is already the current
value is not stored, so a default does not become a stored value.

```
The setup of Megachat is pending. The setup asks the user three questions and stores each answer with agents_settings.
Offer the setup only in a reply to a message of the user. Do not offer it in a report of a child result or of the summary of the past sessions.
In that reply, first answer the message of the user. Then offer the setup in one or two sentences. Say that it has three questions, that the user can skip it, and that the defaults then apply.
Offer the setup one time only. When the user declines it, or ignores the offer in the next message, call agents_settings(action="onboarding", status="skipped").
When the user accepts, read the settings with agents_settings(action="get"). Then ask the questions below, in their order.
Ask one question at a time. Show the current value and the default of each question in plain words.
The user can skip one question. Then keep the current values, and ask the next question.
The user can stop the setup at each question. Then call agents_settings(action="onboarding", status="skipped"). The answers that the user gave stay.
Store each answer at once with agents_settings(action="set", key, value), before you ask the next question. Do not store a value that is already the current value.
When a setting comes from an environment variable, say that the variable wins over the stored value.
The questions of the setup:
1. The agents. Name the current main model of coordinator.model in short words, such as Opus or Fable. Ask which pair the user wants: the main model + Claude, or the main model + Codex on GPT-6 Astra, for example "Opus + Claude" or "Opus + Codex on GPT-6 Astra". In the first pair, a new child task goes to Claude Code (children.agent claude). In the second pair, it goes to Codex with the model GPT-6 Astra (children.agent codex, children.codexModel openai/gpt-6-astra). Do not change coordinator.model: the main model stays in both pairs. Say that a task can still name the other agent. Do not show prices. Do not ask for the reasoning level.
2. The index of past sessions. Ask in the language of the user: "Index past Claude, Codex and pi sessions in your projects, and read the logs of the agent sessions that run on this machine to show their status? Megachat reads the content of a session only when you ask. Everything stays local." The default is off. Say that the import runs in the background and takes the sessions of the last 180 days. Set sessions.index to on only when the user agrees.
3. The known repositories: call agents_projects(action="discover"), show the found repositories as a short list, and add each one that the user chooses with agents_projects(action="add").
At the end, call agents_accounts. This is no question. Show only the agents with a problem and what to fix. When each agent is ready, say nothing about the check.
Then call agents_settings(action="onboarding", status="done"). Then tell the user that each setting can change later in the chat, and that the setup can run again.
```

The file names only `coordinator.model`, `children.agent`, `children.codexModel` and `sessions.index`. The test "the
setup rules name each setting of this build and no other setting" becomes a test of these four keys.

### 2. The pair of agents

- The pair with Claude sets `children.agent` to `claude`. The pair with Codex sets `children.agent` to `codex` and
  `children.codexModel` to `openai/gpt-6-astra`. The question changes only the children. `coordinator.model` keeps its
  value: Opus by default, or the model that the user chose, such as Fable. The question names that model in the
  pairs, for example "Fable + Claude".
- The pair with Claude does not reset `children.codexModel`. A task that names Codex keeps the model of the user.
- The current pair is "<main model> + Codex on GPT-6 Astra" when `children.agent` is `codex`, else "<main model> +
  Claude".
- No prices: the main agent is the same in both pairs, and the registry has no price of GPT-6 Astra. The accounts of
  Claude and Codex pay for the children (see the capability `spend-limit`).
- `coordinator.thinking` keeps its value. The setup does not name it.

### 3. The settings that leave the setup

The old questions 1 (model and reasoning level with prices), 5 (permissions, time limit, list of the sessions), 6
(the reply style and `reply.suggestions`), 7 (cache, summary, memory), 8 (working day, morning report,
`update.auto`), 9 (budget), the parallel count and the child models of question 2, `sessions.notes` and
`projects.newRoot` leave the setup. They keep their defaults. The user changes each of them in the chat, as today.
The removal of question 6 closes the known gap of 6b7c17b ("off, the default").

`sessions.notes` moves to the offers, not to a follow-up question of the index. The setup stays at three questions,
and the first summary of the past sessions after the consent is the natural time for the offer: it lists the
unfinished sessions.

### 4. The account check

The check runs at the end as before. The rules now tell the agent to show only the agents with a problem and what to
fix, and to say nothing about the check when each agent is ready. The check itself does not change. A Codex child on
GPT-6 Astra that Codex does not offer shows only at the first task, because the check opens a session without a prompt
and without a model (see "Risks").

### 5. The offers file

A new file `resources/instructions-offers.md` holds the offer rules, the line "The offers:", and one line for each
offer in the form `- <key>: <trigger>`. The daemon reads the keys from these lines. The proposed text:

```
After the setup, some settings keep their defaults. When a report or a tool result shows that one of them helps, offer it one time.
Before an offer, call agents_settings(action="offer", key). Offer the setting only when the result has allowed=true.
Offer a setting in one sentence of the reply text, with its current value. An offer of a setting is not a next step of the work. Write it in the reply text also when the suggestion rules forbid a next step in the reply text.
Give at most one offer in a turn. When the suggestions show as grey text, you can give the acceptance of the offer as the suggestion of the turn, when the turn has no other suggestion.
Change the setting only after the user agrees. Do not record a refusal.
The offers:
- children.push: A child result says that a push is necessary.
- children.daemonRestart: A child result says that a restart or a stop of the Megachat daemon is necessary.
- children.parallel: agents_list or a child result shows a queued task in another directory while children.parallel tasks run.
- children.timeoutMinutes: A child result says that the run stopped at the time limit.
- children.permissionMode: A Claude child waits for a permission request for a file change.
- budget.dailyUsd: The morning report or agents_settings(action="get") shows a spend of the main agent of 20 USD or more on one day.
- sessions.notes: The summary of the past sessions or the morning report shows an agent session that waits for a permission request or is unfinished.
- workday.enabled: The user says that the work of the day ends, for example that the user leaves for the night, or asks what Megachat costs while the user is away.
- report.morning: The user asks what the agents did while the user was away.
```

The triggers use only data that the main agent sees today: a child result, `agents_list`, the summary of the past
sessions, the morning report and `agents_settings get`. No report gives the keep-alive cost at night, and the agent
has no clock. So the triggers of `workday.enabled` and `report.morning` are messages of the user, as the
author decided. A session note is no turn of the agent, so it carries no offer. The summary and the morning report
carry the offer of `sessions.notes`.

### 6. The offer rules in the rules section

`settingsRules` adds the offer rules after `instructions.settings` when the mode is `reply` or `ghost`, the
onboarding is `done` or `skipped`, and at least one offer is open. Each open offer gets one line with its current
value, for example "children.push (ask): A child result says that a push is necessary." An offer is open when the
state has no record of it, and the setting has no stored value and no variable. The offer of `sessions.notes` is open
only when `sessions.index` is on. A new line of `resources/Megachat.properties`, `instructions.offers.open`, gives the
heading of the lines. Without an open offer, the section holds no offer rules, so a user who answered all of them
pays no tokens for them.

`instructions.settings` becomes "Read or change a setting of Megachat with agents_settings only when the user asks, or
for an offer of the offer rules. When the user asks to run the setup of Megachat again, ...". So the rule and the
offers agree.

### 7. The record of an offer and its storage

The action `agents_settings(action="offer", key)` records an offer. It gives `{ allowed, key, value }`. It gives
`allowed: true` only when all of these hold:

- the mode is `reply` or `ghost`, and the onboarding is `done` or `skipped`;
- the key is in the list, and the offer is open;
- `initiative.silenced` is false;
- no other offer of the same turn got `allowed: true`.

An unknown key gets the code `settingKey`, as `set` does. A known key out of the list gets `allowed: false`.

Storage: the conversation state keeps each allowed offer in a new map `initiative.offers`, as
`{ "<key>": { "offeredAt": "<ISO time>", "turnId": "<requestId of the turn>" } }`. The record goes through
`initiativeDecision` with the ID of the tool call, as `agents_suggest` does. This is the smallest fit:

- The gate needs `initiative.silenced` and the current turn, which are in the same state.
- A tool call that runs again after a crash gets the same result from `decisions`.
- The map is apart from `decisions`, so the cut of `decisions` at 2000 entries does not drop an offer.
- A restart and a compaction keep the state. A compaction changes only the messages.
- An offer is a proposal of the agent, like the proposal decisions, and not a choice of the user. `settings.json`
  keeps only the choices of the user, so the requirements "No change from an automatic turn" and "Tools of the report
  turn" keep their promise that `settings.json` does not change.

The open of a state of an earlier build adds `initiative.offers ??= {}`, as it adds `promptSuggestion` today. The
service keeps a copy of the recorded keys for the rules section: it reads the map at the start and adds a key after
each allowed record. The section shows the change at the next turn, as each change of a setting does.

Alternative: a top-level key `offers` in `settings.json`. An older build keeps it. Refused: the gate would read two
stores, the replay of a tool call would need its own record, and an automatic turn would write `settings.json`.

### 8. The offers and `reply.suggestions`

- `ghost`: the offer is one sentence in the reply text. The offer rules say that an offer is not a next step of the
  work, so the ghost rule "Do not propose a next step in the reply text unless the user asks for one." does not forbid
  it. When the turn has no other suggestion, the agent can call `agents_suggest` with the acceptance, for example "Let
  child tasks push without a question". The gate of `agents_suggest` does not change.
- `reply`: the offer is one sentence in the reply text. It does not go through `agents_suggest`, and a refusal
  changes no counter of the declines.
- `off`: no offer rules and no allowed offer. The mode `off` means no proposal unless the user asks.
- A request for silence stops the offers too, because the gate reads `initiative.silenced`.

### 9. The grey text of the setup

`resources/instructions-onboarding-ghost.md` gets one sentence after "The likely answer keeps the current values of
the question.": "For the pair of agents, the likely answer is the current pair, for example "Opus + Claude"." The
example "Start the setup" stays. The file still names no setting key.

### 10. A present user

The status `done` or `skipped` keeps the setup away, also after the update. A state with `pending` gets the three
questions at the next reply. A present user gets the offers of the settings that have no stored value and no
variable. A user who answered the old setup has stored values, so most of the offers stay closed for that user.

### 11. The daemon, the state and the ACP messages

- A disconnect and a restart: an offer is a tool call of a turn. The record is in the conversation state before the
  tool result, so a restart keeps it, and a replay of the tool call gets the same result. A turn that the restart
  interrupts follows the present continuation.
- `conversation.sqlite`: the new field `initiative.offers`. An older state gets an empty map at its open.
- `settings.json`: no new field. The change reads `onboarding` and `values`, as today.
- ACP: no new message and no new `_meta` key. An offer is an `agent_message_chunk`. Its acceptance as grey text uses
  `_meta.promptSuggestions` of a `session_info_update`, as today.

## Risks / Trade-offs

- [The model of a Codex child] Codex can refuse `gpt-6-astra` on another machine. Then the first Codex task fails
  before its prompt with `error.childCodexModel`, which names the setting. Mitigation: the user picks the pair with
  Claude or sets `children.codexModel` to `inherit`.
- [Fewer questions] A new user does not learn about the permissions of a child, the cache or the working hours in the
  setup. Mitigation: the offers come when a report shows the need, and each setting changes in the chat.
- [Missed triggers] The model decides when a trigger holds. It can miss an offer or give it late. Mitigation: the
  offer is open until it goes out, and the cost of a missed offer is the present default.
- [The rules section changes after an offer] The section goes to the model again in the next turn. It is small, and an
  offer goes out at most nine times in the life of the conversation.
- [A new conversation] A new `conversation.sqlite` with the old `settings.json` gives the open offers again.

## Open Questions

None. The author decided these points:

- The triggers of `workday.enabled` and `report.morning` stay messages of the user, for example "I leave for the
  night". No report gets the keep-alive cost in this change.
- The threshold of the offer of `budget.dailyUsd` is 20 USD on one day.
- The mode `off` gives no offers.
- The pair question changes only the children. The main model keeps its value.
