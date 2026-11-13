# Design

## Context

See `proposal.md`, part "Why". These facts shape the approach:

- Air resolves only the command name `npx` to its own Node.js (`AcpCommandResolver.ensureRuntimeAndResolveCommand`
  and `AcpRuntimeManager.RuntimeType.fromCommandName` of Air). Only for that command, Air puts the `bin` directory of
  its Node.js first on the `PATH` and sets `NPM_CONFIG_CACHE`, `NPM_CONFIG_INCLUDE` and the other npm variables
  (`AcpServerProcessHandlerImpl`). Air passes the `args` of a custom entry without a change. It expands only a `~` at
  the start of an argument.
- Air starts a custom entry in the directory of the project. Air waits for the first answer of the agent with no time
  limit (`AcpAgentClientPool.initializeTimeout` is `Duration.INFINITE` without the property
  `air.acp.initialize.timeout.ms`).
- The change `first-start-feedback` left out "a wrapper command around npx", because another command loses the Node.js
  and the npm cache of the IDE, and macOS has no `timeout` command. This design keeps the command `npx`, and the timer
  is in Node.js. So that reason does not apply.
- `npx` updates a copy in place: the next start after a release writes the new release into the same
  `_npx/<hash>/node_modules/megachat` directory (the walk of 2026-11-14, step 19).
- A probe on this Mac on 2026-11-14, with the Node.js 24.22.1 of the IDE, a temporary npm cache and the registry
  `http://127.0.0.1:9/`: `npx --call '"$NODE" "<dir with a space>/start.mjs"'` in a directory without
  `package.json` started the script with the Node.js of the IDE, gave it the standard input, set `NODE` and
  `npm_execpath`, and ended with the code 0 after 1.6 to 2.0 seconds (0.6 seconds of CPU time, on a loaded machine).
  `git ls-remote --tags https://github.com/ignatov/megachat` took 0.6 seconds.

## Goals / Non-Goals

**Goals:**

- A start without GitHub reaches the running daemon, or starts the installed release, with the Air of today.
- The update after a release stays as it is: the next start with the network installs the new release.
- A usual start with the network takes no more time than today.

**Non-Goals:**

- A change of Air. A time limit and a progress state in Air go to a later IJAI ticket of the author.
- A faster first start. The first start of a release still installs about 870 MB.
- A message in the chat about a start without GitHub.

## Decisions

### 1. The entry keeps the command `npx` and calls the launcher

The entry is `{"command":"npx","args":["--call","\"$NODE\" '<state directory>/launcher/start.mjs'"],"env":{...}}`.
`npx --call` with no package installs nothing and asks no server. It runs the command through `sh -c`, and npm sets
`NODE` to its own Node.js. So the launcher runs with the Node.js, the `PATH` and the npm variables that Air gives the
command `npx`.

The command uses `"$NODE"`, not `node`: npm puts the `node_modules/.bin` directories of the working directory first on
the `PATH`, and Air starts the agent in the directory of the project. A project with a `node` package could otherwise
take the name. `install` quotes the path for `sh` with single quotation marks, and writes a quotation mark of the path
as `'\''`.

Alternatives:

- An absolute path of a shell script as the command. Air then gives no Node.js and no npm variables, and the script
  must guess the Node.js directory of Air, which changes with each Node.js release of Air.
- `node <recorded copy>/bin/megachat.mjs acp` as the entry. Air gives no Node.js to the command `node`, and the update
  stops, because npx never runs.
- `npx -y <state directory>/launcher` with a local package. npm then reifies the package into `_npx`. Nobody checked
  that it asks no server without the network.

### 2. A check of GitHub with a time limit before npx, not npx with a time limit

The launcher runs `git ls-remote --tags --refs` on the repository with a hard time limit of 10 seconds, with its own
environment, so `GIT_HTTP_LOW_SPEED_LIMIT` and `GIT_HTTP_LOW_SPEED_TIME` of the entry apply. It ends git with
`SIGKILL` at the limit. This is the first request that npx makes for `#semver:x`. It takes about 0.6 seconds, so 10
seconds is about 15 times the usual time, and it ends the wait of 78 seconds of a network that drops the packets.

A time limit for npx itself does not work. The first start of a release takes 40 to 112 seconds, so a short limit
stops a good install, and a long limit does not help. The output of npx goes directly to Air, so the launcher cannot
see when npx ended its request to GitHub.

The launcher takes the highest tag `v<major>.<minor>.<patch>` and ignores a pre-release, with the same rule as
`releaseParts` in `src/MegachatUpdate.mjs`. The launcher cannot import that module, so it has a copy of the rule, and a
test compares both on the same list of tags.

### 3. A direct start of the recorded copy when it has the last release

The launcher adds one start of npm (about 1.6 seconds above) and one `git ls-remote` (about 0.6 seconds). When the
recorded copy has the version of the highest tag or a higher version, the launcher starts
`<copy>/bin/megachat.mjs acp` with `process.execPath` and does not start npx a second time. That saves the second
start of npm, the clone of the tag, and the check of the copy by npx. Warm starts of the entry of today took 2.2 to 10.1
seconds, with a median of 3.1 seconds (the walk of 2026-11-14, step 6). So a usual start gets shorter.

The launcher reads the version from `<copy>/package.json` at each start, not from the record, because npx updates the
copy in place. Only a copy with `bin/megachat.mjs` counts.

When the recorded copy is older than the highest tag, or the record is missing, the launcher runs `npx -y
github:ignatov/megachat#semver:x acp` with the `npx` in the directory of `process.execPath`, else the `npx` on the
`PATH`. That is the entry of today, so the update stays as it is. When `MEGACHAT_RELEASE_REPOSITORY` is set, for a
test, the spec is `git+file://<repository>#semver:x`, as in `test/package.mjs`.

Alternative: run npx after each good check. The launcher is smaller, but each start takes about 2 seconds more than
today. The author can select it, and the requirement "Start of the recorded copy" then goes away.

### 4. The daemon records its copy, and `install` writes only the launcher

At each start, the daemon of a copy of npx (`npxCopy` in `src/MegachatUpdate.mjs`) writes `{"root": "<copy>"}` to
`launcher/copy.json`. A daemon start shows that the copy runs. One daemon owns the state directory, and a client of
another build replaces it, so the record names the copy of the newest build that ran. When the daemon runs, a start
without GitHub starts its copy, so the `acp` process has the same build and connects to the running daemon with no
replacement.

`install` writes `launcher/start.mjs` and no record. The copy of `install` is in the npm cache of the terminal, and the
last line of `install` says that the IDE uses a copy of its own. See "Open questions".

The daemon writes `launcher/start.mjs` again when the file exists and its text differs. So a release can correct the
launcher without a new `install`. It never makes a missing file. A daemon of an earlier release can write its earlier
launcher back, after a start without GitHub. That launcher also works, and the next daemon of a newer release writes
its own launcher again.

`src/MegachatLauncher.mjs` holds the text of the launcher, its write and the write of the record. The text has only
`node:` imports. It gets the two lines of `resources/Megachat.properties` (`launcher.offline` and
`launcher.noCopy`), the repository and the time limit as JSON values at the time of the write, so the strings stay in
`resources/Megachat.properties`. Each write goes to a temporary file in `launcher/` with the mode 0600, and a rename
replaces the file. `launcher/` gets the mode 0700, as each directory of the state.

The launcher finds the state directory from its own path, `launcher/..`. It does not read `MEGACHAT_HOME`, because
the entry names the file.

### 5. The process of the launcher

The launcher starts its child with `stdio: 'inherit'`. It never reads the standard input, so the `initialize` request
of Air waits in the pipe until `acp` reads it. It passes `SIGTERM`, `SIGINT` and `SIGHUP` to the child, and exits with
the exit code of the child, or with the code 1 when the child ended by a signal. The child gets the environment of the
launcher. That environment has `npm_execpath` from the npx of the entry, so the rules of a start by npm of the
capability `launch` remove the variables of npm and the time limits of git from the daemon and its children.

### 6. The entry of existing colleagues

Only `install` writes `acp.json`. It replaces the npx entry with the time limits exactly as it replaces the entry of
0.3.0 and 0.4.0: a backup, the same place, the earlier entry in the output. The line is a new string
`install.replacedLauncher`, because `install.replacedEarlier` says that the earlier entry had no time limits. An entry
with another key or another variable stays a different entry. A colleague with the earlier entry gets the new entry
when they run the setup line or the install line again. Until then, the earlier entry works online, as today.

### The admitted work and the state

The launcher does not change the daemon. A start without GitHub starts the build of the running daemon, so no daemon
stops, and the admitted work stays. When no daemon runs, `acp` of the recorded copy starts one, as today. The new state
files are `launcher/start.mjs` and `launcher/copy.json` with the key `root`. No field of `conversation.sqlite` or
`settings.json` changes. An older state directory gets `copy.json` at the next start of a daemon of a copy of npx, and
`start.mjs` at the next `install`. No ACP message and no `_meta` key changes.

The content of the state directory gets a new requirement "Directory of the launcher" and not a MODIFIED "Content of
the state directory": that requirement has about 480 characters with its `Tests:` line, and one more item makes it
longer than the limit of 500 characters of the strict validation.

## Risks / Trade-offs

- [A later npm removes `NODE` or changes `--call`] → each start fails. `test/package.mjs` starts the entry with the
  npm of the test Node.js, and the manual check 4.4 starts it in Air. The command can fall back to `node` when `NODE`
  is empty: `"${NODE:-node}"`.
- [The copy in the npm cache is broken, for example after an interrupted update in place] → a start without GitHub
  fails, as today. The launcher checks only that `bin/megachat.mjs` exists.
- [The recorded copy is in the npm cache of another IDE product, and that product removed it] → with the network, the
  launcher runs npx. Without the network, it writes the line of a missing release.
- [The process tree is deeper: npx, `sh`, the launcher, and then `acp` or npx again] → the launcher passes the signals
  and exits with its child. `acp` ends when its standard input closes, as today.
- [A start that installs a new release takes about 2 seconds more] → it takes 10 to 112 seconds already.
- [A tag that moves to another commit with the same version] → the direct start keeps the earlier commit.
  `release.mjs` never moves a tag.
- [GitHub answers in more than 10 seconds] → the launcher starts the installed release, and the update waits for a
  later start. The daemon still finds the new release and shows it in `status`.
- [An open window when `install` changes the entry] → nobody checked what Air does then. The manual check 4.6 records
  it.

## Migration Plan

1. A release with the launcher. The setup line and the install line write the new entry, with a backup of `acp.json`.
2. The release notes and `README.md` tell existing colleagues to run the setup line again.
3. Rollback: copy `acp.json.before-megachat-<UTC time>` back to `~/.jetbrains/acp.json`, or write the npx entry by
   hand. The directory `launcher/` can stay.

## Open Questions

- Can `install` record its own copy of the terminal, so that the first start in the IDE uses it and does not install
  870 MB again (break 3 of the walk)? That changes the requirement "Last lines and exit code of install" and the disk
  use in `README.md`, so it is a later change.
- Can the message after an update ask an existing colleague to run the setup line again? The capability `update` is in
  the change `automatic-update`, which is not archived yet.
- Does Air show the error output line of the launcher to the user, or only in its log? The manual check 4.5 records it.
