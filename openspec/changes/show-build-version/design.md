# Design

## Context

See `proposal.md` for the reason of the change.

### The code today

- `src/MegachatBuild.mjs` exports `VERSION`, the field `version` of `package.json` (a JSON import). The bundle holds a
  copy of `package.json`, so it gives the same value.
- `VERSION` goes to `agentInfo.version` of `initialize` (`src/AcpBridge.mjs`), to the last line of `install`
  (`src/MegachatInstall.mjs`, the messages `install.copy` and `install.release`), and to the `clientInfo` of the
  requests of Megachat to the Claude and Codex agents and the account check, and to the MCP server
  `megachat-history`. No state file holds it. `src/MegachatSearchIndex.mjs` and `src/SessionIndex.mjs` have their own
  constants with the name `VERSION`.
- `BUILD_ID` is a different value: `dev` for a git checkout (`src/sourceBuildId.mjs`, `gitCheckout`), the version and
  a digest of the files for a copy without `.git`, and the content of `build-id.txt` for the bundle. The daemon
  publishes it in its connection file, and a client of another build replaces the daemon.
- `status` prints `{"running":true,"current":...,"children":[...]}` from `/state`. `/health` gives `version` (the
  version 1 of the connection), `pid` and `build`.

### How a copy of npx gets its files

The install line and the entry of `acp.json` use `github:ignatov/megachat#semver:x`. The places are in npm 11.19.0 on
this machine (`pacote/lib/git.js`, `pacote/lib/dir.js`, `@npmcli/git/lib/spawn.js`):

- npm runs `git ls-remote` on `https://github.com/ignatov/megachat.git`, then on the SSH URL when HTTPS fails, and
  selects the tag with the highest version.
- For a hosted repository with a resolved commit, npm downloads the tarball of that commit from GitHub. Only when the
  download fails does it clone. So the copy has no `.git`.
- `package.json` has the script `build`, so npm prepares the package in the extracted directory of the tarball. A
  `prepare` script would run there without `.git`, and the variable `npm_package_resolved` of that script is the
  temporary directory. So a `prepare` script cannot read the commit.
- The release script makes the tag on the commit of `main`. It cannot write the commit into the files of that commit:
  that needs one more commit, and then the tag is on another tree.
- Two places can give the commit to a copy: `export-subst` in `.gitattributes` (GitHub writes the commit into
  `$Format:%H$` of a file in the tarball), and the record of the resolved URL with the commit in
  `node_modules/.package-lock.json` of the npx directory. Neither one tells without the network whether the commit has
  a release tag. The refs of `$Format:%D$` come from the time when GitHub made the archive, and GitHub can keep an
  archive that it made before the tag. Nobody checked the second place on this machine: the only npx copy here is
  empty.

## Goals / Non-Goals

**Goals:**

- A git checkout that is not exactly a release reports a version that no release reports.
- A copy of the install line, and a checkout at a release tag, report the release form unchanged.
- `status` tells the version of the daemon that runs, not of the checkout.

**Non-Goals:**

- No change of `BUILD_ID`, of the replacement of a daemon, or of the files of the package.
- No commit for a copy without `.git`. See decision 4.

## Decisions

### 1. The form: SemVer build metadata after the version of package.json

`<version>[+[<count>.]g<commit>[.dirty]]`, or `<version>+dev`. The commit has 7 hexadecimal digits, or more when git
needs more for a unique name.

- npm semver 7 on this machine: `valid("0.3.0+64.g1d5ef77")` is `0.3.0`, `satisfies(..., "x")` is true, and the
  comparison with `0.3.0` is 0. `valid("0.3.0-64-g1d5ef77")` is a pre-release that sorts before `0.3.0`, and
  `satisfies(..., "x")` is false. `0.4.0-dev+1d5ef77` is also a pre-release that the range `x` refuses.
- ACP defines `agentInfo.version` as a string to show or to log. Air does not parse it.
- The base is always the version of `package.json`, not the name of the nearest tag. `git describe --match
  v<version>` counts only from the tag of that version. So after the commit that sets `0.4.0`, the version is
  `0.4.0+g<commit>`, and it does not claim a count from `v0.3.0`.

Alternatives: the form of `git describe` (wrong order in SemVer); a version `0.4.0-dev` in `package.json` after each
release (needs a commit and a push in `release.mjs`, and two builds of `main` still report the same version).

### 2. One git command, at the first use, with a time limit

`git -C <root> describe --tags --long --always --dirty --abbrev=7 --match v<version>`, with a time limit of 2 seconds,
no input, no error output, and an environment without `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE`. The output is
`v0.3.0-64-g1d5ef77[-dirty]` when the tag is in the history, else `1d5ef77[-dirty]`. A count of 0 without `-dirty` gives
the release form. An exit code other than 0, a time-out or another output gives `<version>+dev`.

The command took 60 ms on the loaded machine of the author (10 runs). So Megachat runs it only in a git checkout, one
time in each process, at the first use: `initialize` in `acp`, the start of the daemon for `/health`, and `install`.
Another command, such as `stop`, runs no git command.

Alternative: a read of `.git/HEAD` and of the refs without git. It cannot count the commits or see a changed file, and
a worktree and packed refs make it longer.

### 3. The bundle and the daemon

- `build.mjs` computes the version with the same function and defines it for the bundle, next to `MEGACHAT_BUILD_ID`.
  The bundle has no `.git`, so it cannot compute it at run time. `build-id.txt` stays as it is.
- `/health` gets the key `megachatVersion` with the version of the daemon. `status` reads `/health` and prints it as
  `version`. A daemon of an earlier build gives no key, and `status` then prints no key `version`. `/health` is the
  local connection of the daemon, not an ACP message.

### 4. A copy without .git keeps the release form

A copy without `.git` gives the version of `package.json`, as today. The install line and the entry of `acp.json`
select only release tags, so each copy of a supported path is a release. A copy of `github:ignatov/megachat#main` or of
`npm pack` of a checkout reports the release form. That is a known limit.

Alternatives: `export-subst` with `$Format:%H$` and `$Format:%D$`, or a read of `node_modules/.package-lock.json` of
the npx directory. Both give the commit, but neither tells whether the commit has a release tag (see "How a copy of npx
gets its files"). A release copy that reports `<version>+g<commit>` would bring back the confusion of issue #33 in the
other direction.

### 5. The release script

`release.mjs` does not change. `npm run release` runs the build and the tests before it makes the tag, so they see
`<version>+g<commit>`. The tests compare with the computed version of the same checkout, so they pass. No copy of that
run is published. After the tag, the same checkout gives `<version>`. `test/release.test.mjs` keeps its cases.

### The state, the daemon and the ACP messages

- No field of `conversation.sqlite`, `settings.json` or another state file changes. An older state directory needs no
  migration.
- The daemon keeps the admitted work through a disconnect and a restart as today. The version does not take part in
  the replacement of a daemon: `BUILD_ID` stays `dev` in a checkout.
- ACP: `agentInfo.version` of the answer to `initialize` gets the new value. No `_meta` key changes. The `clientInfo`
  of the requests to the agents and the version of the MCP server `megachat-history` get the same value.

## Risks / Trade-offs

- [A checkout gives `+dev` when git is not on the `PATH` of the IDE] → The version still differs from the release.
  `status` and `install` in a terminal show the full form.
- [The `clientInfo.version` with `+` reaches Codex and Claude Code] → Both take a string. Codex puts it in a header
  value, and `+` and `.` are valid there. The tests of the Codex and Claude children run with the new value.
- [60 ms more for the first `initialize` of a checkout] → Only in a git checkout, one time in each process.
- [The version of `agentInfo` is the version of the `acp` process, and the daemon of a checkout can be older] →
  `status` shows the version of the daemon.
- [The tests that compare `agentInfo.version` with `package.json` run in a lease, which is a git worktree] → They
  compare with the computed version of the same checkout.

## Migration Plan

No migration. A rollback is a revert of the commit.
