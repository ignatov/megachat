# Tasks

Rules for each task: never start `src/main.mjs` without a temporary state directory, print no key, no token and no
base URL of Central, and use no recursive delete.

## 1. The marker

- [ ] 1.1 In `src/CentralConfigurationService.mjs`, add the function of D1 to the payload hook chain of `models()`,
  after the hook of Pi Durable and next to `omitThinkingText`. Verify with `npm test`.
- [ ] 1.2 In `test/keepalive.test.mjs`, add a case for each scenario of the requirement "Cache marker before a change
  of the tools" of the capability `keep-alive`. Take the body of each request in the payload hook, as the case of
  `test/session-notes.test.mjs` does, and stop the request there. The first case changes `reply.suggestions` from
  `off` to `reply` between two turns. Check the `Tests:` line of the requirement. Verify that the first case fails
  without the change of 1.1, and that both cases pass with it. Verify with `npm test`.

## 2. Documents

- [ ] 2.1 Add the record of the real run of design.md to `docs/manual-checks.md`.
- [ ] 2.2 Run `openspec validate --all --strict`.
