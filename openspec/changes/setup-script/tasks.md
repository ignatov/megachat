# Tasks

Rules for each task: never run `setup.sh` on this machine outside the test, never start `src/main.mjs` without a
temporary state directory, never run `install` without `MEGACHAT_ACP_CONFIG` set to a temporary file, print no key or
token, run no real `central login` and no real `central add`, and use no recursive delete, also not in the script.

## 1. The setup script

- [ ] 1.1 Write `setup.sh` at the root of the repository for `/bin/bash` 3.2, with all code in `main` (D3) and the
  steps of the capability `setup-script`: platform, git, Node.js on the `PATH` or the download of Node.js 24.22.3 with
  `SHASUMS256.txt` (D4), Central and its login (D5), the Claude key (D6), the empty `acp.json` (D7), the install line,
  and the last lines. Keep the texts in the script in ASD-STE100 (D1). Verify with `bash -n setup.sh` and `shellcheck
  setup.sh`.
- [ ] 1.2 Write `test/setup.test.mjs` with the fake commands of D9 and a case for each scenario of the capability
  `setup-script`: the script from a pipe, no terminal, Linux, no Command Line Tools, a Node.js that is new enough, an old
  Node.js on an Apple silicon Mac, an Intel Mac without Node.js, a wrong checksum, no Central, a failed installer, no
  login, a failed login, no Central entry of Claude Code, a failed `central add claude-code`, an `acp.json` with only
  white space, a successful and a failed install line, two runs, and a key in the output of Central. Check the
  `Tests:` lines of the capability `setup-script`. Verify with `npm test`.

## 2. The release

- [ ] 2.1 In `releaseSteps()` of `release.mjs`, give `setup.sh` to `gh release create` as the last argument (D2).
  Update the case "the release builds the bundle before the tests, and makes the tag only after the tests" of
  `test/release.test.mjs` for the scenario "The asset of the setup script", and add `../setup.sh` to the files of the
  case that checks the install line. Verify with `npm test`.

## 3. Documents

- [ ] 3.1 In `README.md`, make "Install for a colleague" the setup line and a short list: run the line, log in when
  Central asks, select Megachat in the agent list of Air. Say what the script does and that the IDE needs no restart.
  Keep the present manual steps as a fallback section. In "Releases", say that the release gets `setup.sh` as an
  asset. Add a case to `test/release.test.mjs` that `README.md` names the setup line. Verify with `npm test`.

## 4. Integration

- [ ] 4.1 Run `npm test`, `npm run test:package` and `openspec validate --all --strict`. `test:package` checks that
  the package holds no `setup.sh`.

## Workflow follow-up

- The coordinator runs the script on a clean virtual machine and records the result in `docs/manual-checks.md`.
- Archive the change with `/opsx:archive` after the review, and run `openspec validate --all --strict`.
