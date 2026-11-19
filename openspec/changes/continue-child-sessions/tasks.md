# Tasks

The tasks 1 to 4 made the first version (commit `bca6af7`). The tasks 5 to 7 make the rework after the correction of
the author of 2026-11-19 (proposal.md, "Why"). The rework replaces `idleSessions` and the rule of the first version.

## 1. The view in agents_list

- [x] 1.1 Add `idleSessions` to the result of `agents_list` in `src/PiMegachatService.mjs`, with a constant of 24 hours, the limit of 20 entries and the clock of the service. Verify with `npm test`.
- [x] 1.2 Add the cases of "Idle child sessions in agents_list" and "Entry of an idle child session" to a new `test/continue-sessions.test.mjs`: the five sessions of one project, a directory that is no longer listed, 21 sessions, a session with a follow-up, and a Codex session of one run. Use the real values of the scenarios. Verify that `npm test` passes.

## 2. The rule and the tool descriptions

- [x] 2.1 Replace the line "Use agents_send for a follow-up in the same child session." in `resources/instructions.md` with six lines.
- [x] 2.2 Change `tool.spawn`, `tool.send` and `tool.list` in `resources/Megachat.properties`. Keep `tool.resume`.
- [x] 2.3 Add the cases of the rules and of the tool descriptions to `test/continue-sessions.test.mjs`: they read `resources/instructions.md` and the descriptions of the tools of `service.extension()`. Verify that `npm test` passes.
- [x] 2.4 Add a short paragraph to `README.md`, near "Add information to a task that runs": the main agent continues an idle child session of the same topic, names it in one short phrase, and starts a new session when you ask for one.

## 3. The specs

- [x] 3.1 Check that each `Tests:` line of the delta names `test/continue-sessions.test.mjs`, and that each scenario has its case there. Run `openspec validate --all --strict`.

## 4. Checks

- [x] 4.1 Run `npm test`. No change of `build.mjs`, of `package.json` or of a dependency, so `npm run test:bundle` and `npm run test:package` are not necessary.
- [x] 4.2 Replaced by task 7.2.

## 5. The rework of the view

- [x] 5.1 Replace `idleSessions` with `hotSessions` in the result of `agents_list` in `src/PiMegachatService.mjs` (design.md, decisions 2 and 6): a session that works, or an idle session whose last run ended less than 24 hours ago with each status; the fields `state` and `status`; `endedAt` only for an idle session; the sessions that work first. Verify with `npm test`.
- [x] 5.2 Add `childSessionId` to each result of the report of a child result in `src/MegachatState.mjs` (design.md, decision 5).
- [x] 5.3 Change the cases of `test/continue-sessions.test.mjs` for "Hot child sessions in agents_list" and "Entry of a hot child session": the five sessions of one project, a cancelled session and a session that waits, a directory that is no longer listed, 21 sessions, a session with a follow-up, a Codex session of one run, and a session that works. Add the case of "Child session of a result". Use the real values of the scenarios. Verify that `npm test` passes.

## 6. The rework of the rule

- [x] 6.1 Replace the six lines of the first version and the line "When the user adds information to a task that a child works on now, ..." in `resources/instructions.md` with the eight lines of design.md, decision 7.
- [x] 6.2 Change `tool.spawn`, `tool.send`, `tool.steer`, `tool.list` and `error.childBusy` in `resources/Megachat.properties` as design.md, decision 7 says. Keep `tool.resume`.
- [x] 6.3 Change the cases of `test/continue-sessions.test.mjs` for "Continuation of a hot session", "Source of the child session", "Name of the continued session", "Tool descriptions of a continuation" and the scenario "The description of agents_steer" of the MODIFIED "Tool agents_steer". Verify that `npm test` passes.
- [x] 6.4 Change the section "Continue a task" and the section "Add information to a task that runs" of `README.md`: a hot session, the next step of a task that works, and the one result of that task.
- [x] 6.5 Check that each `Tests:` line of the deltas names its test files, and that each new scenario has its case there. Run `openspec validate --all --strict`.

## 7. Checks

- [x] 7.1 Run `npm test`. No change of `build.mjs`, of `package.json` or of a dependency, so `npm run test:bundle` and `npm run test:package` are not necessary. No ACP extension changes, so `docs/air-contract.md` and Air do not change.
- [ ] 7.2 Manual check of the author, in a temporary `MEGACHAT_HOME`: start a task, then ask for a fix of its result. Verify that the reply names the session, and that the log of the daemon has `started kind=send` for the fix. Start a long task, and while it works, ask for its next step. Verify that the reply names the session, that `agents_steer` gives the step to it, and that no new session starts. Then ask for an unrelated task in the same project, and verify `started kind=spawn`. Write the result in `docs/manual-checks.md`.
