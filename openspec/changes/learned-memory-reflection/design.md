# Design

## Context

See `proposal.md` for the reason. This change depends on the change `learned-memory`: the file `memory.md`, the write
of the tool `agents_memory` with its checks and its cap, and the section `memory` of the system prompt. The design of
`learned-memory` gives the facts about the sections of Pi Durable, the summary request and the tools that change a
file. The facts below come from the code at 5034f0e.

### Background model requests

- The summary of the past sessions and the morning report are not model requests of the daemon. The state keeps their
  data and starts an automatic turn of the main agent (`nextSessionsEvent`, `MegachatState.mjs:552`;
  `nextMorningReport`). A user message interrupts such a turn (`interruptAutomaticTurn`, `MegachatState.mjs:745`), and
  commit 78d3a6f tells an interrupted summary one more time.
- A session note is a `write` submission with a note entry and no model request (`MegachatState.mjs:609-630`).
- The only background model requests are the summary (`summarize`, `PiMegachatService.mjs:562`, with its own system
  prompt, a transcript, `cacheRetention: 'none'`) and the keep-alive request (`ping`, `PiMegachatService.mjs:620`,
  the cached context with one short user message). `turnStarted` of the keep-alive aborts a ping
  (`src/PromptCacheKeepAlive.mjs:54`).
- The daily limit only warns. A line in the rules of the next turn asks for one warning, and it goes away after a
  completed turn (`PiMegachatService.mjs:109,277,812-815`; capability `spend-limit`).
- `build.mjs:101` copies all of `resources/` into the bundle, and `build.mjs:28` puts each file into the build ID. The
  `files` of `package.json` hold `resources`. So a new resource file needs no change of `build.mjs` or of
  `package.json`.

## Goals / Non-Goals

**Goals:**
- The reflection writes through the write of the tool `agents_memory`, with the same checks and the same cap.
- A turn of the user never waits for the reflection.

**Non-Goals:**
- No patch and no removal by the reflection.
- No reflection for a child.

## Decisions

### Decisions of the conductor, not reopened

- The reflection only adds. It gives a change or a removal as text in the next reply. It runs with the summary and in
  an idle pass after 10 user turns. The grounding rule is in the prompt.

### Decisions of this design

- **The reflection is a request of its own.** The alternative is a structured tail on the summary request. A
  tail shares the output limit of 16,000 tokens and the `stopReason` check, so a long or broken tail can lose the
  summary, and a summary that holds memory lines puts them into the context. A separate request keeps
  `resources/compaction.md` and its tests as they are. The reflection reads the retained entries after its cursor
  through `root.entries`, not the context, so it does not need the context before the summary. It runs after the
  summary, when the daemon is idle.
- **The reflection request.** The model of the main agent, the system prompt of the first paragraph of
  `resources/reflection.md`, and one user message: the transcript of the entries after the cursor in the format of
  `transcript()` (the newest 60,000 characters, without the entries of `air.megachat.event` and the notes), the current
  entries as the section `memory` shows them, the topics without a blocked topic, as the summary request gets them
  (see the change `learned-memory`), and the rest of `resources/reflection.md` with the grounding rule. `cacheRetention: 'none'`,
  `maxTokens` 1,000, a time limit of 120 seconds. The answer is lines: `add user: <text>`, `add notes: <text>`,
  `propose: <text>`. Megachat ignores each other line, takes at most 5 adds and 3 proposals, and writes each add through
  the write of the tool.
- **The schedule of the reflection.** The state field `memoryReflection` holds `throughEntryId`, `userTurns`, `due` and
  `notice`. A completed turn of the user adds one to `userTurns`. At 10, or after a completed summary, `due` becomes
  true. A timer starts a due pass when no turn runs and the last turn ended 60 seconds ago. `submit` aborts a pass that
  runs, as `turnStarted` aborts a keep-alive request, and the pass stays due. A pass that completes moves
  `throughEntryId` to the last entry that it read and sets `userTurns` to 0. A pass that fails sets `userTurns` to 0 and
  keeps the cursor. No pass starts with `memory.reflection` `false`, or when `budget.dailyUsd` is not 0 and the spend of
  the day is above it.
- **The notice of the reflection.** As the spend warning, the notice is in the rules of the next turn: the section
  `memory` holds the lines of the adds and the proposals and asks the agent to tell them. A completed turn that had the
  notice clears it. The alternative, a note of Megachat in the chat, shows at once without a turn, but the decision
  asks for the text in the next reply.
- **The reflection and the keep-alive.** The reflection request has its own prompt and no cache retention, so it
  neither reads nor renews the prompt cache of the conversation. The keep-alive schedule does not change, and both
  requests can run in the same idle time.
- **The setting `memory.reflection`.** A boolean, default `true`, `applies: 'nextTurn'`. It is a safety valve for a
  user who does not want background learning.

### State, settings and ACP

- `conversation.sqlite`, the state document: the new field `memoryReflection`. `initialize` gives an older state
  `memoryReflection ??= { throughEntryId: <the newest entry ID>, userTurns: 0, due: false, notice: null }`, so the first
  pass does not read the whole old conversation. A daemon of v0.3.0 keeps an unknown field as it is.
- `settings.json`: the key `memory.reflection`. An older file has none, and the default applies.
- A disconnect of the ACP client does not touch the reflection: the daemon owns it. A restart: a pass that runs is
  lost, stays due, and runs again after the next idle time.
- No ACP message and no `_meta` key is new or read. `docs/air-contract.md` does not change.

## Risks / Trade-offs

- [The reflection learns a wrong fact] → It only adds, each add shows in the next reply, the grounding rule applies, and
  `remove` and `undo` take it back.
- [The cost of the reflection] → At most 60,000 characters of input, about 15,000 tokens, after 10 turns or a summary,
  and no pass above the daily limit.

## Migration Plan

No migration of data. A rollback to the build of `learned-memory` ignores the field `memoryReflection`, and
`settings.json` keeps the key `memory.reflection`, which that build ignores as a stored value that it does not know.

## Open Questions

- The words of `resources/reflection.md` can change at review without a change of the specs.
