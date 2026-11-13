# Proposal

## Why

`main` and the last release report the same version (issue #33). When the author wrote the issue, `main` had 64
commits after the tag `v0.3.0`. The IDE got "0.3.0" in `agentInfo.version` from both, and the last line of `install`
said "Megachat 0.3.0" for both. The release v0.4.0 removes that difference only until the next commit on `main`: then
`main` and the release both report "0.4.0". So the author, a colleague and a bug report cannot tell a build of `main`
from the release. The author shows `main` to the Air team, and colleagues install the release.

## What Changes

Where it shows: `agentInfo.version` in the answer to the ACP `initialize` request, the last line of `install`, and the
output of the command `status`.

- **The version of a build.** A copy without `.git` (the install line and the entry of `acp.json`) and a git checkout
  exactly at the tag `v<version>` with no change of a tracked file keep the version of `package.json`, for example
  `0.4.0`. Each other git checkout adds the commit as SemVer build metadata:
  - `0.4.0+3.g1a2b3c4`: 3 commits after the tag `v0.4.0`, at the commit `1a2b3c4`.
  - `0.5.0+g1a2b3c4`: the tag `v0.5.0` of the version is not in the history of the commit yet, for example after the
    commit that sets the next version and before `npm run release`.
  - `.dirty` at the end, for example `0.4.0+3.g1a2b3c4.dirty`, when a tracked file has a change.
  - `0.4.0+dev` when git gives no answer in 2 seconds or fails.
- **Why this form.** ACP gives `agentInfo.version` as a free string, so each form is valid for an ACP client. npm
  semver reads `0.4.0+3.g1a2b3c4` as a valid version equal to `0.4.0` with build metadata, and the range `x` accepts
  it. The form of `git describe`, `0.4.0-3-g1a2b3c4`, is a pre-release in SemVer: it sorts before `0.4.0` and the range
  `x` refuses it. A form such as `0.5.0-dev+1a2b3c4` must guess the next version, and the range `x` also refuses it. The
  build metadata needs no guess and keeps the release form unchanged.
- **The bundle.** `npm run build` writes the version of its checkout into the bundle, so the bundle gives the same
  version as the checkout that built it.
- **`status`.** The command `status` prints the key `version` with the version of the running daemon. A daemon of a git
  checkout keeps running after a pull, so its version can be older than the version of the checkout.
- **`install`.** The last line gives the version of the build. In a checkout of `main` it says, for example,
  "Megachat 0.4.0+3.g1a2b3c4 runs from ...".
- **The build ID does not change.** A git checkout keeps the build `dev`, so a pull or a commit still keeps the running
  daemon. Only the reported version changes.
- **The release script does not change.** A copy of the install line comes from a release tag through `#semver:x`, so
  it keeps the release form. `npm run release` makes the tag after its build and its tests. So the bundle and the tests
  of a release run see the form `<version>+g<commit>`. No copy of that run is published, so this is correct.
- **No ACP extension changes.** `agentInfo.version` is a standard field of ACP. Air needs no change.
  `docs/air-contract.md` gets the new text of the version.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `launch`: the requirement "Version in the agent information" gives the version of the build instead of the version
  of `package.json`. New requirements give the version of a build, the version without an answer of git, and the
  version of the daemon in `status`.
- `install`: the requirement "Last lines and exit code of install" gives the version of the build in the last line,
  with a scenario for a git checkout after the tag.

## Impact

- Code: `src/sourceBuildId.mjs` (the version of a build from `git describe`, with only `node:` imports, so a test can
  run it on a temporary repository), `src/MegachatBuild.mjs` (the version, computed one time per process at the first
  use), `src/AcpBridge.mjs`, `src/MegachatInstall.mjs`, `src/DaemonServer.mjs` (`/health` gives the version of the
  daemon), `src/main.mjs` (`status`), and `build.mjs` (the define of the version for the bundle).
- Tests: `test/launch.test.mjs`, `test/install.test.mjs`, `test/recovery.test.mjs`, `test/bundle.test.mjs`.
  `test/package.mjs` keeps its assertion: a packed copy gives the version of `package.json`.
- Documents: `README.md` (install from a checkout, commands, releases), `docs/air-contract.md` (the version in
  `agentInfo`).
- No field of `conversation.sqlite`, `settings.json` or another state file changes. No state holds the version of
  Megachat: the search index and the session index have version numbers of their own.
- Out of scope:
  - A release. The release v0.4.0 came after this proposal, and only the author starts a release.
  - The commit of a copy without `.git` that does not come from a release tag, such as a copy of
    `github:ignatov/megachat#main` or of `npm pack`. Such a copy keeps the release form. `design.md` gives the reason.
  - A version in `package.json` with a suffix such as `0.5.0-dev` between two releases.
  - The lock of the installed copy (roadmap item 3) and the other risks of the first start (issue #38).
  - No non-goal changes.
