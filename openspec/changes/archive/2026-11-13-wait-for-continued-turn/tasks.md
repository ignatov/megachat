# Tasks

## 1. The prompt of a view

- [x] 1.1 Add the notice `error.daemonLost` to `resources/Megachat.properties`.
- [x] 1.2 In `src/AcpBridge.mjs`, make `prompt` wait for the end of the current turn after `busy` and send the input
      again, and make a Stop end the wait and stop that turn. Verify: the first two cases of
      `test/prompt-wait.test.mjs` fail before the change and pass after it.
- [x] 1.3 In `src/AcpBridge.mjs`, end a prompt that lost its daemon with the notice, give `error.unavailable` before
      the admission, and end the ACP connection 100 ms after the end of the event stream. Verify: the last two cases
      of `test/prompt-wait.test.mjs` pass, and the third one fails before the change.
- [x] 1.4 Give both requirements the `Tests:` line `test/prompt-wait.test.mjs`. Verify:
      `openspec validate wait-for-continued-turn --strict` passes.
- [x] 1.5 Run `npm test`. Verify: all tests pass.

No change of `docs/air-contract.md`: no ACP message changes. No `npm run test:bundle` and no `npm run test:package`:
no dependency, no `build.mjs` and no `package.json` change.
