# Tasks

This change is slice 1, the memory. Slice 2, the reflection, is the change `learned-memory-reflection`. It holds the
requirements "Reflection", "Time of a reflection pass", "Notice of the reflection in the next reply" and "Reflection
and the daily spend", the setting `memory.reflection` and the delta of `spend-limit`. This change can be archived
alone.

## 1. The memory module

- [x] 1.1 Add `src/MegachatMemory.mjs` with the parse of `memory.md` (the three headings, the bullets, the continuation lines, the ignored lines), the size in code points, and the template of a new file from `resources/Megachat.properties`. Verify in a new `test/memory.test.mjs`: a file with each kind of line parses, and a write keeps each ignored line byte for byte.
- [x] 1.2 Add the address rules: a case-insensitive substring, one match, `ambiguous` with the candidates, `noMatch` with at most 3 closest entries, and the span rule of `patch`. Verify the scenarios "Two matches", "No match" and "A patch keeps the other facts of the entry" in `test/memory.test.mjs`.
- [x] 1.3 Add the checks: `secret` with `redactSecrets` of `src/SessionText.mjs` and a `KnownSecrets`, `unsafe` with the Unicode categories Cf and Cc, U+2028, U+2029 and the list of injection marks in one constant, `tooLong`, `duplicate`, and the topic rule `forgotten`. Verify the scenarios "A key and a zero-width space", "An injection" and "An add of a forgotten topic", a topic without a word of 3 characters, and the known value of a `KnownSecrets`.
- [x] 1.4 Add the write: one queue, the read, the version in `memory-versions/` (mode 0700, files 0600, the newest 20), the temporary file with the mode 0600, the second read with at most 3 tries, the rename, and `undo` with the `undone-` file (the newest 5). Verify "The first write", "A line of the user outside the sections", "Undo of a remove", a change of the file between the two reads, a file above 64 KB, and the modes on macOS and Linux.
- [x] 1.5 Add the render of the section: the path, the line about facts, the entries, `[blocked: <reason>]`, the line of an empty memory, and the warning of the cap. Verify "A key in a hand edit" and "An add above the cap". Run `npm test`.

## 2. The tool agents_memory

- [x] 2.1 Add the tool `agents_memory` to the extension `air.megachat` in `src/PiMegachatService.mjs`, with `replay: 'safe'`, the actions `add`, `patch`, `remove`, `forget`, `show` and `undo`, and the request ID `tool:<taskId>:memory`. Pass the path from `src/main.mjs` as the option `memoryPath`, as `settingsPath` goes now. Verify with the faux model of the existing service tests in `test/memory.test.mjs`: "The line of an add", "Forget an employer", and the `show` result.
- [x] 2.2 Refuse each action but `show` in an automatic turn. Verify "A child result asks to remember" in `test/memory.test.mjs`.
- [x] 2.3 Add the state field `memoryWrites` to `src/MegachatState.mjs`, with `memoryWrites ??= {}` in `initialize` and the prune at 200 records. Record the outcome before the rename. Verify "A restart after the rename" in `test/memory.test.mjs` and the default of the field in a state of v0.2.0 in `test/upgrade.test.mjs`.
- [x] 2.4 Add the setting `memory.characters` to `src/Settings.mjs` (integer, 1,000 to 20,000, default 4,000, `nextTurn`), and name it in `resources/instructions-onboarding.md`. Verify the first part of "The defaults of the memory" in `test/settings.test.mjs` and that "the setup rules name each setting of this build and no other setting" still passes. Run `npm test`.

## 3. The prompt section and the summary

- [x] 3.1 Add the section `memory` after `settings`, with the snapshot that is read again when `state.current.id` changes. Verify "The section of an empty memory" and "A hand edit between two turns" in `test/memory.test.mjs`: count the `pi.system` entries of the root conversation before and after a turn without a change.
- [x] 3.2 In `summarize`, append the line of the topics of `## Do not remember` to the instructions of the summary request. Verify "A forgotten topic" in `test/compaction.test.mjs`, and that the earlier cases of that file pass with no change.
- [x] 3.3 Verify in `test/memory.test.mjs` that the state directory of a daemon without a write holds no `memory.md` and no `memory-versions/` (the delta of `state-directory`).
- [x] 3.4 In `entryText` of `src/MegachatSearchIndex.mjs`, skip each `agents_memory` call and its result, and keep the other blocks of the entry. Verify "A call of agents_memory in the index" in `test/search-index.test.mjs`, and "A history search after a forget" in `test/memory.test.mjs` for `history` of the service and for the tool `history` of the children. Run `npm test`.

## 4. The rules and the strings

- [x] 4.1 In `resources/instructions.md`, replace line 10 ("Do not claim perfect recall or a separate personal memory...") with the rules of the memory: when to save, the grounding rule, the project file rule, the line of each write, `show` and the path on request, the limit of `forget`, no restatement of a forgotten topic from a search result, only the current section counts, and no copy of the memory into a child prompt. Keep "Do not claim perfect recall". Verify "The rules of the memory" in `test/memory.test.mjs`, and "The result of a forget".
- [x] 4.2 Put each new text in `resources/Megachat.properties`: the tool description `tool.memory`, the lines of each action, the reasons of a refusal, the note of `forget`, the header and the empty line of the section, the warning of the cap, the template of the file, the line of the summary request, the description of the setting, and the log lines. Verify that `test/memory.test.mjs` finds no literal user-visible text in `src/MegachatMemory.mjs`. Run `npm test`.

## 5. Children

- [x] 5.1 Verify "A pi child with a memory" in `test/pi-child.test.mjs`: no request of the child holds `<memory>` or the entry.
- [x] 5.2 Verify "A Claude child and a Codex child with a memory" in `test/child-settings.test.mjs`: the prompt of the fake agent does not hold the entry. Run `npm test`.

## 6. Documents and checks

- [x] 6.1 Update `README.md`: the rows of `memory.md` and `memory-versions/` in the table of the state directory, the row of `memory.characters` in the table of the settings, and a short paragraph about the memory, forget and its limit.
- [x] 6.2 Check that each `Tests:` line of the deltas of `learned-memory`, `state-directory`, `compaction`, `settings` and `conversation` names the files of groups 1 to 5, and that each scenario matches a test case with its values.
- [x] 6.3 Run `npm test` and `openspec validate --all --strict`. No change of `build.mjs`, of a dependency, of `package.json`, of the launcher or of `install`, so `npm run test:bundle` and `npm run test:package` are not necessary. No ACP extension changes, so `docs/air-contract.md` and Air do not change, and no IJAI ticket is necessary.

## 7. Fixes of the review

- [x] 7.1 The line and the record of a forget name only the section and the topic. A forget removes each other record of `memoryWrites`, deletes each version and each undone file, and `undo` after it gives `afterForget`. Verify "Forget an employer", "A forget deletes the versions", "The records after a forget" and "A history search after a forget", with a reply that quotes the line.
- [x] 7.2 The topic rule compares whole Unicode words without the stop words, and a word of 5 or more letters matches its inflected forms. `forget` refuses a topic without a topic word with `topic`. `forget` removes only the addressed entry and gives the entries of the topic rule as `otherMatches`. `remove` can address a topic. Verify "A topic word inside another word", "An inflected form", "A topic without a word" and "A remove of a topic" in English and Russian.
- [x] 7.3 `show`, a line, a candidate and a closest entry give a blocked entry without its raw text. Verify "Show of blocked entries".
- [x] 7.4 The parse: a byte order mark and a heading of level 3 or lower. The write: a symbolic link, a link to no file, the version before the second read, no second copy of a version, the sequence numbers, the digest of the last write for `undo`, and the removal of a temporary file of a crash. The address: the exact match wins, and the search uses the original text. Verify each new scenario of the requirements "Structure of a file of the user", "Symbolic link of the memory file", "Exact address and case of an address", "Steps of a write", "Versions of the memory", "Undo after a hand edit" and "Temporary file after a crash".
- [x] 7.5 The unsafe check refuses only the listed format characters and a heading start, and "system prompt" is no mark. Verify "The text of each script".
- [x] 7.6 The rule "save only what the user said" and the rules of forget in `resources/instructions.md`. Verify "The rules of the memory" and "The rules of forget".
- [x] 7.7 Verify "The first turn after the upgrade" with the system entries of a conversation of a build without the memory, "A kill of the daemon during a write" with `test/memory-daemon.mjs`, and "An undo that runs again after a hand edit".

## 8. Fixes of the second review

- [x] 8.1 An indented bullet is an entry of its own. Verify "A remove of a parent and of a child" in `test/memory.test.mjs`.
- [x] 8.2 A `forget` without a match, or with a match that finds no entry, adds the topic and deletes the versions and the records, with `matched: false`. Verify "Forget after a remove" and "An ambiguous match of a forget".
- [x] 8.3 A forget deletes the versions and removes the records only after its rename. Verify "A forget that ends busy".
- [x] 8.4 Each field of a result with a text of the file passes `visible`, also the topic of `forgotten`, and the summary request gets no blocked topic. Verify "A blocked topic in a refusal" with one table of the result fields, and "A blocked topic" in `test/compaction.test.mjs`.
- [x] 8.5 The stem rule keeps at least 5 letters and allows at most 3 letters more, in both directions. A short word drops a final `'s`, an English word also matches its forms with -s, -es and -ies, and a Russian word of 3 or 4 letters matches an ending of at most 2 letters. Write the known limits in `design.md`, and the backstop rule in `resources/instructions.md`. Verify "A word of another meaning with the same start" and "Short inflected forms".
- [x] 8.6 The injection marks match the text in lower case with one space for each run of white space, and the check refuses U+FFF9 to U+FFFB, U+180E, U+115F, U+1160 and U+3164. Verify "An injection with other case and white space" and "The text of each script".
- [x] 8.7 The record of a write holds the digest before the write, and a call that runs again applies its action again only for that digest, else it gives `replayed`. Put the note `memory.replayed` and the line `memory.line.topicKept` in `resources/Megachat.properties`. Verify "A remove that runs again after a later write" and "An undo that runs again after a hand edit".
- [x] 8.8 The test of the kill of the daemon fails at once when the forked daemon ends before its message. Run `npm test` and `openspec validate --all --strict`.

## Workflow follow-up

- Archive the change: the deltas merge into `openspec/specs/learned-memory/spec.md` (new), `state-directory`,
  `compaction`, `settings` and `conversation`.
- Run `openspec validate --all --strict` after the merge.
- Do not close issue #31 with this commit. The change `learned-memory-reflection` closes it.
