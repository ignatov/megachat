# Tasks

## 1. The entry of a stopped turn

- [ ] 1.1 Add the marker `reply.stopped` to `resources/Megachat.properties`.
- [ ] 1.2 In `src/ReplyStream.mjs`, add the kind `STOPPED_KIND` (`air.megachat.stopped`) and `stoppedReplyText`, which
      makes the text from the newest entries of the turn. Verify: the case "the text of a stopped turn takes the
      partial reply of its last request, and a full reply gives no text" in `test/stream.test.mjs` passes.
- [ ] 1.3 In `src/PiMegachatService.mjs`, make `finish` read the text of a turn with `current.cancelling` and give it
      to `settleInput`. In `src/MegachatState.mjs`, make `settleInput` write the entry with the submission `write` in
      the commit that ends a cancelled turn. Verify: the cases "the next request after a stopped reply holds the
      partial text with the stop marker, and the chat shows it one time" and "the next request after a reply stopped
      before its first text holds only the stop marker" in `test/stream.test.mjs` fail before the change and pass
      after it.
- [ ] 1.4 Leave the entry out of the chat and the replay (`src/AcpBridge.mjs`), of `agents_history`
      (`src/PiMegachatService.mjs`) and of the search index (`src/MegachatSearchIndex.mjs`). Verify: the case "a stopped
      reply keeps its partial text one time, in the chat and in a replay" in `test/stream.test.mjs` and the case "the
      entry of a stopped turn is not indexed" in `test/search-index.test.mjs` pass.
- [ ] 1.5 Give the requirement "Stopped reply in the model context" its `Tests:` line: `test/stream.test.mjs` and
      `test/search-index.test.mjs`. Verify: `openspec validate mark-stopped-turn --strict` passes.
- [ ] 1.6 Run `npm test`. Verify: all tests pass.
- [ ] 1.7 Run the reproduction of the essay and the count once with a real model, with a temporary `MEGACHAT_HOME`.
      Verify: the second reply counts from 1 to 5 and does not finish the essay. Record the run in
      `docs/manual-checks.md`.

No change of `README.md`: it does not describe what the model sees after a Stop. No change of `docs/air-contract.md`:
no ACP message changes. No `npm run test:bundle` and no `npm run test:package`: no dependency, no `build.mjs` and no
`package.json` change.

## Workflow follow-up

- The author approves the proposal.
- Archive the change, so its delta goes into `openspec/specs/reply-stream/spec.md`.
- Run `openspec validate --all --strict` after the archive.
