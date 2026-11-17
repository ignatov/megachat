# Tasks

## 1. The check and the request

- [x] 1.1 In `src/MegachatUpdate.mjs`, add `checkNow`, `summary`, the tick of the timer, `apply`, `installKind`, `retireCopy` and `removeRetired`. Add `updateWork` and the tool `agents_update` to `src/PiMegachatService.mjs`, and set `service.updater` in `src/main.mjs`.
- [x] 1.2 Add the texts to `resources/Megachat.properties` and the rule `instructions.update` to the settings section.
- [x] 1.3 Cover "Check on demand", "Timer of the check", "Update on request", "Request from an event", "Copy that cannot update itself" and "Fresh start of npx" in `test/update.test.mjs`. Run `npm test`.

## 2. The default

- [x] 2.1 Set `update.auto` to `true` in `src/Settings.mjs`, add the migration and the `autoOn` line of the note. Cover "One-time start of the automatic update" in `test/settings.test.mjs` and `test/update.test.mjs`. Run `npm test`.

## 3. Documents

- [x] 3.1 Update `README.md`, `docs/air-contract.md` and `docs/manual-checks.md`. Run `npm test`, `npm run test:bundle` and `openspec validate --all --strict`.
- [ ] 3.2 Manual check of the author on a real IDE build with a copy of npx: ask "update yourself" with a temporary new tag, and see that the daemon stops after the reply, that Air starts the agent again at the next message, and that npx installs the new release. Record it in `docs/manual-checks.md`.
