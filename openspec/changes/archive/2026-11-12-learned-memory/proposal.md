# Proposal

## Why

Megachat does not learn. The only text about the user is `<state>/instructions.md`, and only the user writes it. The
user wants a chat that remembers the preferences of the user, forgets a fact on request and does not learn it again,
and has a memory that the user can read and edit by hand (issue #31). `resources/instructions.md` tells the model not
to claim a separate personal memory, and the capability `state-directory` reserves the name `memory.md` for this.

## What Changes

Where it shows: the chat, through the reply of the main agent; the file `<state>/memory.md`, which the user opens in
the IDE from a plain path in the reply; and the log of the daemon. The task list of Air does not change.

- **The file.** `<state>/memory.md`, mode 0600, with three sections `## About the user`, `## Working notes` and
  `## Do not remember`, one bullet for each entry. The setting `memory.characters` (default 4,000) caps the size. A
  file above the cap loads with a warning, and `add` is refused. Megachat never truncates a hand edit.
- **The tool `agents_memory`.** The actions `add`, `patch`, `remove`, `forget`, `show` and `undo`. A unique substring
  addresses an entry. No match gives the closest entries. More than one match changes nothing and gives the
  candidates. No action replaces a whole entry. `add` writes without a question to the user, and each write gives one
  line with the exact change, which the reply quotes.
- **Forget.** `forget` removes the one addressed entry and adds a short topic to `## Do not remember`. It names the
  other entries of the topic, and it does not remove them. A deterministic rule of whole words refuses a later `add`
  of the topic. A forget deletes the earlier versions, so no undo brings the entry back. The reply tells the limit: the stored conversation and `agents_history` keep the
  original messages, and the earlier text of the memory stays in the model context until the next summary. The
  summary request gets the topics and drops them.
- **The prompt.** A section `memory` of the system prompt shows the file. It renders again at the first model request
  of the next turn after a change of the file, by the tool or by hand.
- **Safety.** Each write goes through the secret filter and a check for prompt injection and invisible Unicode. A bad
  entry of a hand edit shows as blocked in the prompt and stays in the file. A turn of a child result, of the morning
  report or of the sessions summary cannot write the memory. Each write but a forget keeps the earlier file as a version in
  `<state>/memory-versions/`, so `undo` can take it back. `undo` does not remove a hand edit.
- **Children.** No child gets the memory: not a pi child, not a Claude child, not a Codex child.
- **Rules.** `resources/instructions.md` replaces the rule against a separate personal memory with the rules of the
  memory: when to save, the grounding rule, what to show, and the limit of `forget`.
- **History.** The search index and `agents_history` skip the arguments and the result of each `agents_memory` call,
  for the main agent and for a child. So the text of an `add` or of a `show` does not come back through a history
  search after `forget`.

The reflection, a background pass that adds entries, is slice 2. It is the change `learned-memory-reflection`, which
depends on this change. This change can be archived alone.

## Capabilities

### New Capabilities

- `learned-memory`: the file `memory.md`, its cap, the prompt section, the tool `agents_memory`, forget, hand edits,
  versions, the checks of each write, and the rules of the main agent.

### Modified Capabilities

- `state-directory`: the requirement "Content of the state directory" names `memory.md` and `memory-versions/` in the
  place of the reserved name.
- `compaction`: the requirement "Summary content" drops each topic of `## Do not remember` from the summary.
- `settings`: the requirement "List of the settings of the reply" names the capability `learned-memory` with
  `memory.characters`.
- `conversation`: the requirement "History lookup results" excludes the arguments and the result of an
  `agents_memory` call. No requirement of `openspec/specs/` holds the content of the search index, so the requirement
  of the lookup results takes the rule.

No requirement of `openspec/specs/` holds the rule against a separate personal memory. Only line 10 of
`resources/instructions.md` holds it, so the new requirement "Rules of the main agent for the memory" replaces it.

## Impact

- Code: a new module `src/MegachatMemory.mjs` (parse, render, checks, writes, versions); `src/PiMegachatService.mjs`
  (the tool, the section, the summary request); `src/MegachatState.mjs` (the field `memoryWrites`);
  `src/Settings.mjs` (one setting); `src/MegachatSearchIndex.mjs` (the calls of `agents_memory`); `src/main.mjs` (the
  path of the file).
- Resources: `resources/instructions.md`, `resources/instructions-onboarding.md`, `resources/Megachat.properties`.
- Tests: new `test/memory.test.mjs`; cases in `test/compaction.test.mjs`, `test/settings.test.mjs`,
  `test/pi-child.test.mjs`, `test/child-settings.test.mjs`, `test/upgrade.test.mjs` and `test/search-index.test.mjs`.
- `README.md`: the rows of `memory.md` and `memory-versions/` in the table of the state directory, and the row of the
  setting.
- No ACP extension changes. "Open in the IDE" is a plain file path in the reply. So `docs/air-contract.md` and Air do
  not change. No new dependency.
- Out of scope: the reflection (the change `learned-memory-reflection`); learned procedures (skills that Megachat
  writes); a purge of a forgotten fact from `conversation.sqlite`, from the user messages and the replies in
  `search.sqlite`, and from `agents_history`; embeddings and an external memory provider; a view of the memory in Air.
  No non-goal changes.
