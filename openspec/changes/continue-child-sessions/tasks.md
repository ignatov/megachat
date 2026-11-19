# Tasks

## 1. The view in agents_list

- [ ] 1.1 Add `idleSessions` to the result of `agents_list` in `src/PiMegachatService.mjs`, with a constant of 24 hours, the limit of 20 entries and the clock of the service (design.md, decisions 2 and 3). Verify with `npm test`.
- [ ] 1.2 Add the cases of "Idle child sessions in agents_list" and "Entry of an idle child session" to a new `test/continue-sessions.test.mjs`: the five sessions of one project, a directory that is no longer listed, 21 sessions, a session with a follow-up, and a Codex session of one run. Use the real values of the scenarios. Verify that `npm test` passes.

## 2. The rule and the tool descriptions

- [ ] 2.1 Replace the line "Use agents_send for a follow-up in the same child session." in `resources/instructions.md` with the six lines of design.md, decision 4.
- [ ] 2.2 Change `tool.spawn`, `tool.send` and `tool.list` in `resources/Megachat.properties` as design.md, decision 5 says. Keep `tool.resume`.
- [ ] 2.3 Add the cases of "Continuation before a new session", "Name of the continued session" and "Tool descriptions of a continuation" to `test/continue-sessions.test.mjs`: they read `resources/instructions.md` and the descriptions of the tools of `service.extension()`. Verify that `npm test` passes.
- [ ] 2.4 Add a short paragraph to `README.md`, near "Add information to a task that runs": the main agent continues an idle child session of the same topic, names it in one short phrase, and starts a new session when you ask for one.

## 3. The specs

- [ ] 3.1 Check that each `Tests:` line of the delta names `test/continue-sessions.test.mjs`, and that each scenario has its case there. Run `openspec validate --all --strict`.

## 4. Checks

- [ ] 4.1 Run `npm test`. No change of `build.mjs`, of `package.json` or of a dependency, so `npm run test:bundle` and `npm run test:package` are not necessary.
- [ ] 4.2 Manual check of the author, in a temporary `MEGACHAT_HOME`: start a task, then ask for a fix of its result. Verify that the reply names the session, and that the log of the daemon has `started kind=send` for the fix. Then ask for an unrelated task in the same project, and verify `started kind=spawn`. Write the result in `docs/manual-checks.md`.
