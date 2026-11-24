# Tasks

## 1. The facts of Junie and of Air, before the code

These checks use the real Junie of the author, so ask the author before the first one. Work in a test repository.
Delete nothing in `~/.junie`, and send no `session/delete`. Keep a list of `~/.junie/sessions` from before and after
each check. Print no text of a session: print the names of the fields and the counts. Write each result in
`docs/manual-checks.md`. When a result differs from a delta or from a decision of `design.md`, correct the delta and
`design.md` before the code, and tell the author.

- [x] 1.1 Start Junie in a terminal in the test repository and send one prompt. Verify: the record says which files under `~/.junie` the process keeps open, whether `~/.junie/processes` or `~/.junie/instances` names the session of a process, and the `cwd` of the process. Decide with the result whether the source gets `keepsOpen` (design.md, decision 5).
- [ ] 1.2 In an Air build, press "Done" on that session of Junie, and then restore it. Then add a line with `archived` true by hand in the format of design.md, decision 6, for that session and for a session of a linked git worktree, and add a line with `archived` false. Verify: the record holds the line that each action of Air adds to `agent-workbench-archive-state.jsonl` (the names of the fields and the value of `archived`), whether Air hides and shows the session after each line by hand without a restart, and whether a file of the session folder changed. When Air writes another format, change decision 6 and the two requirements of the archive first. Do the check for both providers of the rows of Junie: before Air starts the Junie of its ACP registry, and after (design.md, "The check in an Air build on 2026-11-24").
- [x] 1.3 Send three more prompts in that session, one of them after a stop and a `junie --resume --session-id=<session ID>`. Verify: the record says whether the inode of `events.jsonl` stays and whether its size only grows, and that the resume command of the card continues the session.
- [x] 1.4 With the Brave Mode of that session off, ask for a command that needs an approval, wait 1 minute, and approve it. Then ask a task that makes Junie ask a question, wait 1 minute, and answer. Verify: the record holds the kinds and the states of the lines from the request to the answer, and they give the steps of the requirement "Step of a Junie session". Set a changed `braveMode` of `~/.junie/settings.json` back.

## 2. The source

- [x] 2.1 Add `src/JunieSessionSource.mjs` with `all`, `files`, `matches`, `relevant`, `nameId`, `describe` and `parse` (design.md, decisions 1 to 4), and add it to `sessionSources` of `src/SessionSources.mjs`. Describe `describe` and the steps `permission` and `question` in the comment of the interface there. Verify: `npm test`.
- [x] 2.2 Add `test/junie-sessions.test.mjs` with fixtures that have the shapes of the read of `design.md` and invented texts: "The files of the source", the three scenarios of "Project directory and title of a Junie session", "A turn with a command", "An answer to a question", "A long output" (also a line of 400,000 bytes), "A fork", "The steps of a turn", "A permission and its answer" and "A question". Verify: `npm test`, and each scenario has its case with the same values.

## 3. The index and the session tools

- [x] 3.1 Call `describe` of a source in the import of `src/SessionIndexService.mjs` before the lines of a file, and count the agent `junie` in the progress and in the summary of the first pass. Verify: a case in `test/session-index.test.mjs` imports a Junie session of a listed directory and leaves out one of another directory, and `npm test` passes.
- [x] 3.2 In `src/SessionHistoryService.mjs`, make `junie` an agent without a live provider, as `pi`, and give the name of the agent to the text `error.sessionsIndexOff` in `resources/Megachat.properties`. Add `junie` to the agents of `src/MegachatHistoryServer.mjs`. Verify: the cases "A search for a reply of Junie", "Junie without the index" and "A read from the end" in `test/junie-sessions.test.mjs`, the present case of pi with its text, and `npm test`.

## 4. The running sessions, the status and the notes

- [x] 4.1 Add the program `junie` and the name `Junie` to `src/AgentProcesses.mjs`, and call `describe` in `#full` of `src/SessionCatalog.mjs`. Add the cases "A session of Junie" to `test/running.test.mjs`, and "A terminal session with its log" and "A Junie child of Megachat" to `test/session-logs.test.mjs`. Verify: `npm test`.
- [x] 4.2 In `src/SessionStatus.mjs`, give `waiting_for_permission` for the step `permission` and `waiting_for_user` for the step `question` (design.md, decision 4). In `src/SessionNotes.mjs`, name `Junie`. In `src/RunningAgents.mjs`, give the time of the event of the wait (`stepAt` of the live table) as the start of the wait of a Junie session. Add the cases "A permission for 20 minutes", "A question for 40 minutes" and "An answered permission" to `test/junie-sessions.test.mjs`, and "The note of a permission" to `test/session-notes.test.mjs`. Verify: `npm test`.

## 5. The archive

- [x] 5.1 In `src/SessionArchive.mjs`, add the agent `junie` to the accepted agents, the hide and the restore with a line of the archive state file (design.md, decision 6), the read of the last line of a session for `archivedState`, `describe` in `inScope`, and the command of Junie in `resumeCommand`. Name `Junie` in `sessionAgentName` of `src/AcpBridge.mjs`. Verify: `npm test`.
- [x] 5.2 Add the cases to `test/archive.test.mjs`: "The card of a Junie session", "A session that waits for a permission", "The line of a hide", "Archive twice" and "Restore of a Junie session". Verify: `npm test`, and no case writes outside a temporary directory.
- [x] 5.3 After the check of 2026-11-24: add `metadataArchived` and `writeMetadataArchived` to `src/JunieSessionSource.mjs`, and make the hide and the restore of `src/SessionArchive.mjs` write both stores (design.md, decision 6). Add `error.junieMetadata` to `resources/Megachat.properties`. Verify: `npm test`.
- [x] 5.4 Add the cases of "Metadata of Junie for an archive" to `test/archive.test.mjs`, and change "Archive twice" and "Restore of a Junie session" to the two stores. Verify: `npm test`, and each scenario has its case with the same values.
- [x] 5.5 Probe the Junie of the ACP registry of Air: `session/list` with the capability `sessionIndex` before and after a write of `session_metadata.json` in one process. Verify: `docs/manual-checks.md` holds the result.

## 6. The continue of a session

- [x] 6.1 After the change `junie-child` is in the code: check that `agents_resume` of `src/PiMegachatService.mjs` takes the agent `junie` through `sessions.read`, and add the cases "An existing Junie session" and "A session of another directory" to `test/integration.test.mjs`. Verify: `npm test`.

## 7. The texts and the documents

- [x] 7.1 Name Junie in the question about the index in `resources/instructions-onboarding.md`, `resources/instructions-onboarding-ghost.md`, `resources/instructions-onboarding-project.md` and the ghost file of a project if there is one, and in `onboarding.offer`, `onboarding.offer.project`, `setting.sessions.index`, `sessions.task.progress`, `tool.sessions`, `tool.resume`, `tool.running`, `tool.archive` and `history.instructions` of `resources/Megachat.properties`, and in the lines of `resources/instructions.md` about the session tools. Change the case of "The question of the setup" in `test/session-index.test.mjs`. Verify: `npm test`.
- [x] 7.2 In `README.md`, name Junie in the texts about the index of past sessions, the running sessions, the notes, the archive and the continue of a session, with the files that Megachat reads and the two files that it writes. Verify: the text names `~/.junie/sessions`, `events.jsonl`, `summary.json`, `index.jsonl`, `agent-workbench-archive-state.jsonl` and `session_metadata.json`.

## 8. The checks of the whole

- [x] 8.1 A real run with a temporary `MEGACHAT_HOME`, the checkout and the index on: find and read a real session of Junie with `agents_sessions` and `agents_session_history`, see a Junie session of a terminal in `agents_running` with its status, also while it waits for a permission, archive and restore one session, and continue one with `agents_resume`. Verify: `docs/manual-checks.md` holds each result and the time of the first pass, and the list of `~/.junie/sessions` shows no lost entry.
- [x] 8.2 Check that each `Tests:` line of the deltas names the files of the cases, and that each scenario has its case with the same values. Verify: `npm test` and `openspec validate --all --strict` pass. `npm run test:bundle` and `npm run test:package` are not necessary: `build.mjs`, `package.json`, the launcher, `install` and the dependencies do not change.

## Workflow follow-up

- Apply and archive `junie-child` before task 6.1 and before the archive of this change.
- Archive `session-archive` before this change: the requirements of the archive of a Junie session refer to it.
- When the change `session-catalog` comes, the source of Junie joins its catalog on the same interface.
