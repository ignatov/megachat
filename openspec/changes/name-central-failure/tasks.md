# Tasks

## 1. The cause of a failure of Central

- [ ] 1.1 Add `lastFailure = { cause, at }` to `CentralConfigurationService`. Set `central_missing`, `central_command`,
  `central_proxy`, `central_unreachable` and `central_refused` as `design.md` says. Verify with a unit case in
  `test/failure.test.mjs` for each error: `ENOENT`, the exit code 1, `killed` with `SIGTERM`, a configuration that
  `validate` refuses, a `TypeError` with the cause `ECONNREFUSED`, a cause `ECONNRESET`, and the statuses 401, 403 and
  529 (no cause). Run `npm test`.
- [ ] 1.2 Give `PiMegachatService.open` the option `centralFailure`, and pass it from `src/main.mjs`. In `finish`, take
  the cause only for the reason `model_error` and only when its time is after `admittedAt`. Write it with
  `settleInput` as `input.cause`. Verify with `npm test`.

## 2. The text in the chat

- [ ] 2.1 Add `error.central.missing`, `error.central.command`, `error.central.proxy`, `error.central.unreachable` and
  `error.central.refused` to `resources/Megachat.properties`, with the texts of `proposal.md`.
- [ ] 2.2 Select the text by `settled.cause` in `AcpBridge.prompt`. A missing or unknown cause keeps the present rule.
  Verify with `npm test`.

## 3. Tests and specs

- [ ] 3.1 In `test/failure.test.mjs`, add a reply through the service of Central for each scenario of the requirement
  "Text of a failure of Central": a missing command, a command that prints "Not logged in" and exits with the code 1,
  a closed port, a server that closes the connection, and a server that answers 401. Check the text of the notice, the
  cause code in the state, and that the state holds no key and no text of the provider.
- [ ] 3.2 In `test/integration.test.mjs`, add a reply that fails with the status 529 (no cause code, the present text),
  and a reply that fails after a cause of an earlier turn (the present text).
- [ ] 3.3 Put `test/failure.test.mjs` in the `Tests:` line of "Failed reply", and run
  `/opt/homebrew/bin/openspec validate --all --strict`.

## 4. Documents and checks

- [ ] 4.1 In `README.md`, near the requirement of the Central login, say that the chat names a missing command, a
  failed login, a stopped proxy and a refused request, and the command for each.
- [ ] 4.2 Run a manual check with `MEGACHAT_HOME` set to a temporary directory: a Central command that `central logout`
  made fail, if the author allows it, or else a copy of the real output that the author gives. Record the exit code and
  the text in `docs/manual-checks.md`, without a key or a URL of Central.
- [ ] 4.3 Run `npm test` and `/opt/homebrew/bin/openspec validate --all --strict`. The change touches no `build.mjs`,
  no dependency and no `package.json`, so `npm run test:bundle` and `npm run test:package` are not necessary.

## Workflow follow-up

- `/opsx:archive name-central-failure` after the author accepts the implementation.
