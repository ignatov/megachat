# Tasks

Rules for each task: never start `src/main.mjs` without a temporary state directory, never run `install` without
`MEGACHAT_ACP_CONFIG` set to a temporary file, use no network in a test (`test/state-guard.mjs` sets the sources of the
release to local values), and use no recursive delete.

## 0. Order

- [ ] 0.1 Check that the change `automatic-update` is archived, so `openspec/specs/update/spec.md` exists. If it is not,
  keep this change open and apply it on top of the open change. Check that the peer change about the message after an
  update is decided, and read how it sends an entry of the kind `air.megachat.note` (design D2). Verify with
  `openspec list`.

## 1. The note of a release

- [ ] 1.1 Add the key `update.releaseNote` and the log key `log.update.noted` to `resources/Megachat.properties` (design
  D4). Verify with `npm test`.
- [ ] 1.2 Add `MegachatState.releaseNote(release, version)`: one commit that writes the entry of the kind
  `air.megachat.note` with `data.type` `release` and sets `update.noted`, only when no turn runs, `pi.live.run` is
  absent, the inbox is empty and `noted` is absent or lower (design D2, D3). Add cases to `test/update.test.mjs` for
  the scenarios "One note for each release": "The next check and a restart", "A higher release" and "An earlier
  state". Verify with `npm test`.
- [ ] 1.3 Add the callback `note(release)` to `UpdateCheck`. Call it in `conditions()` before the decision of the stop,
  and connect it in `src/main.mjs` with `npxCopy()`, `update.auto` and `service.sleeping()` (design D1). Add cases to
  `test/update.test.mjs` with the fake clock for the scenarios of "Note of a new release" and "Time of the note of a
  release": a copy of npx with `update.auto` `false`, a git checkout, `update.auto` `true`, a turn that runs from 10:00
  to 10:03, and a night with `workday.enabled` on. Check that the model of the test got no request and that the state
  has no input after the note. Verify with `npm test`.
- [ ] 1.4 Add a case to `test/update.test.mjs` for "Text of the note of a release" with the version
  `0.4.0+3.g1a2b3c4`. Verify with `npm test`.
- [ ] 1.5 Add a case to `test/update.test.mjs` that attaches a view with the ACP bridge and checks that the view gets the
  note as an `agent_message_chunk` with a message ID that matches `megachat-entry-<number>`. Verify with `npm test`.
- [ ] 1.6 Check the `Tests:` line `test/update.test.mjs` of each new requirement of `update`. Verify with
  `openspec validate --all --strict`.

## 2. Documents

- [ ] 2.1 In `README.md`, "Update": say that a copy of npx with `update.auto` off writes one note in the chat for each new
  release, and what the note tells the user to do. Verify by reading the paragraph against the requirements.
- [ ] 2.2 In `docs/air-contract.md`, "The end of the agent for an update": add one line that the note of a new release
  goes to the views as the notes about the sessions that wait. Verify with `npm test`.

## Workflow follow-up

- Archive this change after `automatic-update`, and run `openspec validate --all --strict`.
