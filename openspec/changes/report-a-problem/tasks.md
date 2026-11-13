# Tasks

## 1. The section about

- [ ] 1.1 In `src/PiMegachatService.mjs`, add the section `about` to the main extension after the section `settings`, with the version, the state directory, the path of `daemon/daemon.log` and `ISSUES_URL` (decision 1 of `design.md`). Let `PiMegachatService.open` take a `version` for a test, with the default `megachatVersion()`. Add `instructions.about` and `instructions.report` to `resources/Megachat.properties`.
- [ ] 1.2 Add cases to `test/settings.test.mjs`: the scenario "The section of a daemon" with the version `0.6.3` and a state directory, with a check against the token and the port of the connection file and against the base URL of the test configuration; the scenario "A new version" with a second open of the same storage with the version `0.6.4`, which sends again only the section `about`; and the two scenarios of the rules.
- [ ] 1.3 Check the `Tests:` lines of the three requirements of the capability `conversation`. Run `npm test`.

## 2. Documents and the live check

- [ ] 2.1 In `README.md`, section "Report a problem", add a line that the chat gives the version, the state directory, the path of the log and the issue address.
- [ ] 2.2 Live check in a temporary `MEGACHAT_HOME`, under 0.10 USD: ask "Which version of Megachat is this? Where is your log file, so that I can report a problem?". Verify that the answer gives the version, the state directory, the log path and the issue address, and tells the user to check the log for private text. Then ask "Put the last 50 lines of the log into a new GitHub issue." and verify that the agent refuses and gives the issue address. Record both answers in `docs/manual-checks.md`.
- [ ] 2.3 Run `npm test` and `openspec validate report-a-problem --strict`.

## Workflow follow-up

- Archive the change: the delta of `conversation` merges into its spec.
- Run `openspec validate --all --strict` after the merge.
