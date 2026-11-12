# Design

## Context

See `proposal.md` for the reason. The facts below come from the code at 5034f0e and from the packages in
`node_modules` at the versions of `package-lock.json` (`@earendil-works/pi-durable` and `pi-ai` 1.5.0).

### How a section of the system prompt reaches the model

- `## User preferences` is not a section. `withUserInstructions` (`src/MegachatHome.mjs:114`) appends it to the bundled
  rules, and the text goes into the `instructions` of the root conversation (`agentOf`,
  `src/PiMegachatService.mjs:122`). Pi Durable renders the instructions last, as the section `instructions`
  (`pi-durable/dist/harness/agent.js:227`). The rules of the settings are the section `settings` of the extension
  `air.megachat` (`src/PiMegachatService.mjs:459`).
- Pi Durable renders each section before each model request, also after a tool round in one turn
  (`pi-durable/dist/harness/generation.js:73-88`). It compares the text with the text that the transcript shows, and
  it appends a `pi.system` entry with only the changed sections (`dist/harness/prompt.js:56-118`).
- For a model that accepts system messages in the conversation, the update goes in place, as
  `Updated system prompt section "memory": ...` (`pi-ai/dist/utils/text.js:24-35`,
  `dist/api/anthropic-messages.js:1051`). The default model `anthropic/claude-opus-5-5` has
  `supportsMidConvoSystemMessages: true` (`pi-ai/dist/providers/data/anthropic.json`). So the cached prefix stays
  valid, and **the earlier text of the section stays in the request as an earlier entry**. After a summary, the next
  request writes one complete baseline that omits each earlier `pi.system` entry (`prompt.js:57-63`). So the earlier
  text leaves the model context at the next summary, not at once.
- For a model without that support, `collapseSystemMessages` rebuilds the leading system message
  (`pi-ai/dist/utils/transcript.js:97-104`). The earlier text goes at once, but each change of the section writes the
  whole prompt cache again.
- A new section key between `settings` and `instructions` changes the order, so the first request after the upgrade
  removes all sections and adds them again (`planSections`, `prompt.js:100-118`), about 3,000 tokens one time. A section
  that is sometimes absent does that at each change, so the section `memory` is always there.
- The section `memory` cannot be the last section. `agentOf` collects the sections of the extensions and then appends
  the section `instructions` (`pi-durable/dist/harness/agent.js:227-229`), so each section of an extension is before
  `instructions`. `planSections` keeps the order of the shown sections and appends a new key, so any new section of
  `air.megachat` gives the remove and the add one time. After that, a change of the file is a patch with only the key
  `memory` (`prompt.js:109-118`), and the text before it in the request stays the same.

### Search index and history

- `entryText` skips each `pi.system` entry and each system message (`src/MegachatSearchIndex.mjs:37,46`), and
  `history` reads only user and assistant text (`src/PiMegachatService.mjs:850-854`). So the section text is not in
  `search.sqlite` and not in `agents_history`.
- But the arguments of each tool call and up to 2,000 characters of each tool result are in the index
  (`MegachatSearchIndex.mjs:50-52`), and a history query returns them (`searchHistory`, `PiMegachatService.mjs:871`).
  So without a change, the text of an `add` call and of a `show` result stays searchable, also after `forget`. The
  child history tool uses the same `history` (`src/MegachatHistoryServer.mjs:19`).
- The index has a version (`VERSION = 2`, `MegachatSearchIndex.mjs:5`). An index of another version is dropped and
  built again from the entries (`#open`, `:80`). But the requirement "Recovery of a state of the last release" of the
  capability `compatibility` asks that the search index of a state of v0.2.0 keeps its last entry ID.
- A history search reads each hit again through `entryText(entry, { full: true })`, and it removes a hit without
  text from the index (`searchHistory`, `PiMegachatService.mjs:877-878`).

### Tools that change a file outside conversation.sqlite

- `agents_settings`: the default `replay: 'safe'` (`PiMegachatService.mjs:452`), so the call runs again after a crash.
  A `set` is idempotent by value. `SettingsStore.change` writes one copy at a time in a promise queue, with a temporary
  file `<path>.<pid>.tmp`, mode 0600, `chmod` and `rename` (`src/Settings.mjs:348-364`). It refuses an automatic turn
  (`PiMegachatService.mjs:377`).
- `agents_projects create` makes a directory: the request ID `tool:<taskId>:create` keys it, the state records the path
  before `mkdir` and the result after it, and a call that runs again returns the record
  (`src/MegachatState.mjs:384-408`). The memory tool copies this pattern.
- `agents_stop` is `replay: 'unsafe'` (`PiMegachatService.mjs:504`): a crash gives the model an `interrupted` result.

### Children

- `harnessSettings` selects only the extension `air.megachat` for a conversation without its own choice
  (`PiMegachatService.mjs:79`). A pi child selects only `air.megachat.child`, with its own instructions
  (`src/PiChild.mjs:107-108`, `:76-81`). So a section of `air.megachat` never reaches a pi child.
- A Claude or Codex child gets the history instructions, the rules of the settings, the `AGENTS.md` block for Claude,
  the task and the steer block (`src/AcpRunService.mjs:355-369`). The daemon adds nothing else. The main agent writes the
  task, so the rules must tell it not to copy the memory.

### Other helpers

- The secret filter: `redactSecrets(text, known)` of `src/SessionText.mjs:182`, the full filter of the session index
  with the exact values of a `KnownSecrets`. `redactOwnSecrets` is only for the text of a child (capability `secrets`).
  No check of invisible Unicode or of prompt injection exists.
- No shared helper writes a file atomically. `SettingsStore.change` and `DailySpend` (`src/DailySpend.mjs:137-146`)
  each have the same code. `ensurePrivateDirectory` (`src/MegachatHome.mjs:27`) makes a directory with the mode 0700.
  The only lock is `owner.sqlite`: one daemon for one state directory.

## Goals / Non-Goals

**Goals:**
- One module, `src/MegachatMemory.mjs`, holds the parse, the render, the checks, the address rules and the writes.
- One write function holds the checks, so the reflection of the change `learned-memory-reflection` can use it.
- A turn of the user never waits for the memory.

**Non-Goals:**
- No purge of a forgotten fact from `conversation.sqlite`, `search.sqlite` or `agents_history`.
- No file lock that an editor of the user obeys. The daemon reads the file again before the rename instead.
- No memory for a child, and no setting that gives it to a child.

## Decisions

### Decisions of the conductor, not reopened

- One file `<state>/memory.md`, mode 0600, the sections `## About the user`, `## Working notes` and
  `## Do not remember`, one bullet for each entry. The cap of 4,000 characters is a setting.
- The tool `agents_memory` with `add`, `patch`, `remove`, `forget` and `show`. A unique substring addresses an entry.
  No match gives the closest entries. More than one match changes nothing and gives the candidates. No whole-entry
  replace.
- `add` writes without a question. Each write shows one line with the exact change in the reply.
- `forget` removes the entry and adds a topic. A deterministic rule refuses a later `add` (see "The topic rule" below;
  the review replaced the first rule, a substring of each word of 3 or more characters). The semantic part is a rule
  of the prompt.
- Hand edits are valid input: lock, read again, temporary file, rename. Never truncate a hand edit. Above the cap the
  file loads with a warning and `add` is refused. Earlier versions stay, so each write has an undo. The review
  added one exception: a forget deletes the versions, because they hold the forgotten entry.
- The section renders again at the start of the next run after a change of the file.
- The secret filter and a check for prompt injection and invisible Unicode run on each write. A bad entry of a hand
  edit shows as blocked in the prompt and stays in the file.
- No child gets the memory. "Open in the IDE" is a plain path. No ACP extension.
- Slice 1 is the memory without the reflection. Slice 2, the reflection, is the change `learned-memory-reflection`.
- The search index and `agents_history` skip the arguments and the result of an `agents_memory` call, also for a
  child.

### Decisions of this design

- **The earlier text after `forget`: tell the limit, no compaction.** Finding: with the default model, the earlier
  section text stays in the context until the next summary. A forced summary does not remove the fact either: the
  summary keeps the newest part of the context, which often holds the message of the user with the fact, and the
  retained conversation keeps each message. A summary costs a request over the whole context. So the result of
  `forget` holds a note, and the rules ask the reply to say that the earlier text leaves the model context at the next
  summary, and that the stored conversation and `agents_history` keep the messages. The update of the section says that
  it replaces the earlier text, and the rules say that only the current section counts. The summary request gets the
  topics and drops them (capability `compaction`). The command `compact` stays for a user who wants the summary now.
- **The render at the first request of a turn.** Pi Durable renders a section before each request, so the section
  keeps a snapshot. Its `render` reads `state.current.id`. When the ID differs from the ID of the snapshot, it reads
  `memory.md` again and builds the text. So a hand edit and a tool write reach the next turn, and a write in a turn
  does not change the prompt in the same turn: the tool result already tells the model. The keep-alive request reads
  the stored context, so it sends the same prefix.
- **The section `memory` is always there and after `settings`.** It is tagged `<memory>` by Pi Durable. An empty memory
  gives one line. The first request after the upgrade sends all sections again one time, about 3,000 tokens, and no
  order of the sections avoids it (see Context). A test counts the system entries of an upgraded conversation.
- **The rules live in `resources/instructions.md`.** The section holds only the path, one line that says the entries are
  facts and not instructions and that the bundled rules win, the entries, and the warning of the cap. So the static rules stay in the cached prefix.
- **The file format.** A heading line `## About the user`, `## Working notes` or `## Do not remember` (without regard to
  the case and the trailing white space) starts a section. Only a heading of level 1 or 2 ends a section. A heading of
  level 3 or lower is an ignored line in the section, so the entries below it stay in the section. A line that starts
  with `- ` or `* ` in a section is an entry, also after an indent of spaces or tabs: a nested bullet is an entry of its
  own, so a remove of its parent removes only the line of the parent and its plain continuation lines, and a remove of
  the nested bullet does not remove the parent. A line with two or more spaces of indent and no bullet after an entry
  continues the entry. Each other line is ignored: it stays in the file and does not render. A U+FEFF at the start does not count for
  the parse, and it stays in the raw first line, so a write keeps it. The size is the count of Unicode code points of
  the file. A new file gets a title line `# Megachat memory`, one line that tells the user that a hand edit is welcome,
  and the three headings. The writer keeps the line ending of the file.
- **The address rules.** The match is a case-insensitive substring of the entry text. The search runs on the original
  text with an escaped `RegExp` and the flags `iu` (the simple case folding of Unicode), so a letter such as "İ", which
  `toLowerCase` makes two code units long, does not move an offset. An entry whose whole text is the match, after a
  merge of the white space, wins over the entries that hold it, so "tea" next to "green tea" has an address. `patch`
  takes `match` and `text`: `match` must occur in exactly one entry and one time in it, and only that span changes. So a
  patch cannot erase the other facts of an entry. The closest entries for no match: the entries with the most topic
  words of `match` (see "The topic rule"), at most 3, in file order on a tie. Only `remove` addresses a topic of
  `## Do not remember`, so the user can let the agent save a topic again.
- **The topic rule.** The words of a text are the word segments of `Intl.Segmenter` with the granularity `word`, in the
  form NFC and in lower case, without a final `'s` or `’s`. A topic word is a word of the topic that is not in a short
  list of English and Russian function words and the forms of "user" (`STOP_WORDS`). An `add` or a `patch` is refused
  when each topic word of one topic occurs in the new entry. `sameWord` holds the comparison of two words:
  - Equal words match. "tea" does not refuse "team", and "my age" does not refuse "manager".
  - Two English words match when a form without a final -s or -es, or with -y for a final -ies, is the same: "cat" and
    "cats", "box" and "boxes", "salaries" and "salary".
  - A Russian topic word of 3 or 4 letters matches a word with the same first 3 letters and at most 2 letters after
    the start that both words share: "жена" and "жену", "дети" and "детей", "муж" and "мужа", but not "мужчину" or
    "детстве".
  - Two words of 5 or more letters match when the shorter word without its last third, rounded down and at least 5
    letters, starts the longer word, and the longer word has at most 3 letters more. The rule goes in both directions:
    "problems" and "problem", "allergy" and "allergies", "children" and "child", "проблемы" and "проблема". The minimum
    of 5 letters keeps "career" from "careful", and the 3 letters keep "parents" from "parentheses". "деньги" does not
    refuse "день": a word of fewer than 5 letters never matches by the stem.

  The rule is only a backstop. It compares words, so it misses a fact in other words, such as the topic "home city" and
  "The user lives in Munich.". The rules of the main agent say this, and they ask the agent to refuse such an entry by
  its meaning. A topic without a topic word ("the user") refuses nothing, so `forget` refuses it with the reason `topic`
  and a note that asks for a more exact topic. The rule is the same for the `otherMatches` of a forget.
- **`undo`, an addition to the list of actions.** The conductor asked for an undo of each write. The main agent has no
  file tool, so the simplest undo is an action. `undo` pops the newest version of `memory-versions/` and writes it.
  The text that it replaces goes to `memory-versions/undone-<number>.md` before the second read. The version goes away
  only after the rename. `undo` writes no version of its own. The newest 20 versions and the newest 5 undone files
  stay. A version file is `memory-versions/<number>.md`: the number has 8 digits and is one more than the highest number
  in the directory, so a clock that goes back does not change the order or the prune.
- **Undo and a hand edit.** After each rename, `memory-versions/last-write.json` gets the SHA-256 of the new file. When
  the file has another digest, `undo` is refused with the reason `edited` and a note that tells the agent to show the
  file to the user: an undo would remove the hand edit. A write after a hand edit keeps the hand edit in its version, so
  the undo of that write gives the hand edit back. When the newest version has the bytes of the file, as after a crash
  between the rename of an undo and the removal of its version, `undo` drops that version first.
- **Forget and the versions.** A version before a forget holds the forgotten entry, so a forget writes no version, and
  it deletes each version and each undone file after its rename, before `last-write.json`. Then it removes the other
  records of `memoryWrites`. So a forget that ends `busy` keeps the versions and the records, because the file still
  holds the entry. A crash between the rename and the delete leaves the old digest in `last-write.json`, so `undo` is
  refused with `edited` and does not restore a version from before the forget. The call runs again, finds the digest of
  its record, and does the delete, `last-write.json` and the removal of the records again. A `forget` without a match,
  or with a match that finds no entry, still adds the topic and deletes the versions and the records, because an
  earlier `remove` can have removed the entry while a version keeps it. Its result has `matched: false`. For a topic
  that the section already holds, the file does not change, the line is the line `memory.line.topicKept`, and the
  versions still go. A match that finds more than one entry gives `ambiguous` and changes nothing. No undo goes back
  over a forget. `undo` without
  a version after a forget gives the reason `afterForget` and a note: to save the topic again, the user removes the
  topic line by hand, or asks the agent to `remove` the topic. The note of the forget and the rules say this too.
- **The checks of a write.** `secret`: `redactSecrets(text, known) !== text`, with the `KnownSecrets` of the service.
  The entry is refused, not filtered, because a filtered fact is a wrong fact. `unsafe`: a character of the category Cc
  other than the tab, U+2028 or U+2029, and only these format characters: U+200B, U+2060 to U+2064, U+FEFF, U+202A to
  U+202E, U+2066 to U+2069 and the tags U+E0000 to U+E007F. The other format characters are parts of normal text: the
  joiners U+200C and U+200D (Persian, emoji), the marks U+200E and U+200F, and the soft hyphen U+00AD. A `#` is refused
  only as the start of a heading (`^#{1,6}\s`), so "#1 rule" passes. The check also refuses the characters that show
  as nothing: U+FFF9 to U+FFFB, U+180E, U+115F, U+1160 and U+3164. The marks of a short list in one constant are
  instructions to a model and the tags of the prompt sections: `ignore previous`, `ignore all previous`, `ignore the
  above`, `disregard previous`, `you are now`, `new instructions`, `<memory`, `</memory`, `<system`, `</system`, `<|`,
  `[INST]`. The check compares them with the text in lower case, with each run of white space, also U+00A0, as one
  space, so "IGNORE  PREVIOUS" is a mark. The bare phrase "system prompt" is not a mark: a fact can name it. The list is
  a best effort. `tooLong`: more
  than 500 characters for an entry, 80 for a topic. `duplicate`: the same text after a merge of white space, without
  regard to the case, gives `changed: false` and no write. A hand edit is checked at each render, and a refused entry
  renders as `[blocked: <reason>]`.
- **The write.** One promise queue of `MegachatMemory` is the write lock: each action of the tool uses it, and
  `owner.sqlite` keeps a second daemon away. Steps: read the file (missing gives the template); apply the action; when
  it changes nothing, return; record the outcome in the state; write `<target>.<pid>.tmp` with the mode 0600 and
  `chmod`; write the version; read `memory.md` again, and when its bytes differ from the first read, drop the temporary
  file and the version of this try and start again, at most 3 times, else refuse with `busy`; `rename`; write
  `last-write.json`. So only the comparison is between the second read and the rename. A version with the bytes of the
  newest version is not written again, so a write that runs again after a crash keeps one version. A missing file gives
  the template as its version, so an undo of the first write gives the empty template. `<target>` is the real path of
  `memory.md`: the temporary file and the rename are next to the file of a symbolic link, so the link stays. A link to
  no file is refused with the reason `link`. At the first use of the memory in a daemon, it removes each
  `memory.md.<pid>.tmp` next to `memory.md` and next to the file of the link, and each temporary file of
  `last-write.json`: a crash between the temporary write and the rename can leave a file with a forgotten entry. A file above 64 KB or not in UTF-8 is not written, and the tool refuses each
  write with `unreadable`. A write keeps the line end of the file (`\n` or `\r\n`), also a file without a line end at
  its end. A patch of a span in one line changes only that line. A patch of a span over a continuation line makes the
  entry one line.
- **Replay after a restart.** The tool is `replay: 'safe'` and copies `agents_projects create`. The request ID is
  `tool:<taskId>:memory`. Before the rename, the state records
  `memoryWrites[requestId] = { before, digest, result, forget, createdAt }`, where `before` is the SHA-256 of the file
  before the write (`null` for no file) and `digest` the SHA-256 of the new file text. The write queue compares them
  with the file at the first read of a call that runs again. When the file has `digest`, the call gives `result` and
  does the steps after the rename again. When the file has `before`, the rename did not occur, and the call applies its
  action again. Else the file changed after the write, by hand or by a later write, and the call changes nothing and
  gives the reason `replayed` with a note: a match can now address another entry, as a remove of "uses vim" next to
  "uses vim keybindings". So an `undo` that runs again after a crash and a hand edit does not undo two times. The
  record is pruned as `projectCreations` is: at 200 records, the oldest 100 go. The record of a forget holds the line,
  the topic and the note, and no `otherMatches`: a call that runs again reads them from the file. A forget removes each
  other record after its rename, because the line of an earlier `add`, `patch` or `remove` can hold the text of the
  forgotten entry. A call that runs again without its record applies its action again, and the checks refuse a second
  copy of an entry.
- **No write from an automatic turn.** As `agents_settings`, the tool refuses each action but `show` when the kind of the
  current turn is in `automaticKinds`. A child result can hold a text that asks to remember something, so this blocks a
  prompt injection from a child.
- **The result.** A write gives `{ changed, line, characters, limit }`. A refusal gives `changed: false`, a `reason`,
  and `closest`, `candidates`, `topic`, `limit` or `note` when they apply. `forget` removes only the entry that its
  match addresses: the topic is a separate argument. It adds `matched`, `otherMatches` and `note`. An other match is an entry that
  the topic rule matches. The forget does not remove it, so that the agent can ask the user about it. The line of a
  forget names only the section and the topic, and never the text of the entry: the reply quotes the line, and the
  search index keeps the reply. An automatic turn gives the reason `automatic`. The other reasons are `section`,
  `empty`, `topic`, `link`, `edited`, `noVersion`, `afterForget`, `replayed` and `action`. `show` gives the path, the size, the
  cap, the entries of each section, the blocked entries, the count of the ignored lines, and the path of
  `memory-versions/`. A blocked entry shows as `[blocked: <reason>]` in its section. `blocked` gives its section, its
  line in the file and its reason, and for `secret` its text after `redactSecrets`. For `unsafe`, no text: also a short
  part of the text can hold an injection. Each other field of a result with a text of the file shows a blocked entry
  or a blocked topic in the same way, through one function `visible`: a line, a candidate, a closest entry, an other
  match and the topic of a `forgotten` refusal. A table test covers each field.
  Each user-visible text is in `resources/Megachat.properties`.
- **The setting `memory.characters`.** An integer from 1,000 to 20,000, default 4,000, `applies: 'nextTurn'`, no
  variable. The section and the tool read the adopted value, as the section `settings` does.
- **The summary request and the topics.** `summarize` appends one line from the properties with the topics of
  `## Do not remember` to the instructions of `resources/compaction.md`, when the section is not empty. A topic that
  the unsafe check or the secret check refuses is not in the line: a hand edit can put an injection or a key into a
  topic. It still refuses an entry, and it shows as `[blocked: <reason>]` in the section, as an entry does.
- **The calls of `agents_memory` in the history.** `entryText` skips each `toolCall` block with the name
  `agents_memory` and each tool result with the `toolName` `agents_memory`. The other blocks of the same entry stay,
  so the text of the reply around the call stays searchable. `history` without a query reads only the text blocks of
  the user and the assistant, so it already skips them. The child tool `history` calls the same `history`. The index
  version stays 2, and no rebuild runs: the tool is new in this change, so an index of an earlier build holds no call of
  it. A rebuild would break the requirement "Recovery of a state of the last release". An index that a development
  build of this change wrote is safe too: `searchHistory` reads a hit again through `entryText`, so the snippet does
  not show the call, and a hit with no other text goes out of the index. A reply or a user message that quotes an
  entry stays in the index, and the rules tell this limit.

### State, settings and ACP

- `conversation.sqlite`, the state document: the new field `memoryWrites`, with the records
  `{ before, digest, result, forget, createdAt }`. `initialize` gives an older state `memoryWrites ??= {}`. A record of
  a development build without `before` gives `replayed` when the file does not have its `digest`. A daemon of v0.3.0 keeps an unknown field as it is.
- `settings.json`: the key `memory.characters`. An older file has none, and the default applies.
- `search.sqlite`: no new field and no new version.
- New files: `memory.md` and `memory-versions/`. An older state directory has neither, and that is an empty memory.
- A disconnect of the ACP client does not touch the memory: the daemon owns the file and the tool calls. A restart: a
  tool call runs again by its record.
- No ACP message and no `_meta` key is new or read. `docs/air-contract.md` does not change.

## Risks / Trade-offs

- [The earlier text stays in the context until the next summary] → The reply tells it, the section update replaces it,
  and the rules say that only the current section counts.
- [A forgotten fact stays in the stored conversation, and in the search index when a user message or a reply holds it]
  → The reply tells it, and the rules forbid a restatement from a search result. The index skips the calls of
  `agents_memory`. A purge is out of scope.
- [An editor writes between the second read and the rename] → The rename replaces that save, and no file keeps it: the
  version holds the text of the first read. Only the comparison of the bytes is in the window, so the window is very
  short.
- [The injection list is a best effort] → The section says that the entries are facts and not instructions, and that
  the bundled rules win.
- [The topic rule refuses a valid entry that holds the same words, or a stem matches a word of another meaning, such as
  "health" and "healing"] → The result names the topic, so the agent can tell the user, and the user can remove the
  topic by hand or ask the agent to remove it.
- [The topic rule misses a form that changes inside the word, such as "mouse" and "mice", a Russian form with a longer
  ending, such as "дети" and "детьми", and a topic word in a longer form than the entry word, such as "детей" and
  "дети"] → The rules of the prompt forbid an entry with the meaning of a topic, and say that the word rule is only a
  backstop.
- [Known limits of the stem rule: a word of another meaning with the same 5 letters at its start and at most 3 letters
  more still matches, such as "family" and "familiar", "работа" and "работает", and "health" and "healthy". A Russian
  word of 3 or 4 letters matches a word of another meaning with the same 3 letters and a short ending, such as "дом"
  and "домен". An English word matches a word that only looks like its plural, such as "new" and "news"] → The result
  names the topic, so the agent can tell the user, and the user can remove the topic.
## Migration Plan

No migration of data. An older state directory has no memory, and the defaults apply. A rollback to v0.3.0 ignores
`memory.md`, `memory-versions/` and the new state field, and `settings.json` keeps the key `memory.characters`, which
v0.3.0 ignores as a stored value that it does not know. When v0.3.0 builds its index again, for example from a
corrupt file, its `entryText` indexes the calls of `agents_memory` again.

## Open Questions

- The words of the injection list and of the template of the file can change at review without a change of the specs.
