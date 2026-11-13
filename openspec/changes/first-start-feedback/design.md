# Design

## Context

See `proposal.md` for the reason of the change.

### The start of the entry today

The entry of a copy is `{"command":"npx","args":["-y","github:ignatov/megachat#semver:x","acp"]}`. The IDE starts
`npx` with its own Node.js and its own npm cache, and it waits for the answer to `initialize` with no time limit. The
places below are in npm 11.19.0 on this machine.

- `pacote/lib/git.js`: npm runs `git ls-remote` on the HTTPS URL of the repository first. When that fails, it runs it
  on the SSH URL. It selects the tag with the highest version, then downloads the tarball of that commit from GitHub
  with its own HTTP client. It clones only when the download fails.
- `@npmcli/git/lib/spawn.js` and `errors.js`: a git command that fails with a connection error runs up to 3 times,
  with a wait of 1 second and then 10 seconds. A connection error is an error output with "Connection timed out",
  "Operation timed out", "Connection reset by peer" and some others. "Operation too slow" and "Could not resolve host"
  are not connection errors, so they give no second run. The number of runs is `fetchRetries || 2`, so
  `fetch-retries` 0 does not remove the second and the third run.
- `@npmcli/git/lib/opts.js`: npm passes its environment to git. It sets `GIT_SSH_COMMAND` to
  `ssh -oStrictHostKeyChecking=accept-new` only when the environment and `~/.gitconfig` have no SSH command.
- So the `env` of the entry reaches git when the IDE passes the `env` of `acp.json` to the command. Nobody checked
  that on an IDE build. Task 5.4 checks it.

### The local probe of 2026-11-13

A Node.js server on `127.0.0.1` accepted each connection, read the input and never answered. git 2.50.1 (Apple
Git-155). No request left the machine.

| Command | Variables | Result |
| --- | --- | --- |
| `git ls-remote http://127.0.0.1:<port>/megachat.git` | `GIT_HTTP_LOW_SPEED_LIMIT=1000`, `GIT_HTTP_LOW_SPEED_TIME=5` | exit code 128 after 5.3 s, "Operation too slow. Less than 1000 bytes/sec transferred the last 5 seconds" |
| the same | none | no end in 45 s (the probe stopped it) |
| `git ls-remote https://github.com/ignatov/megachat.git` with `https_proxy` set to the server | the two variables, time 5 | no end in 45 s |
| the same | none | no end in 45 s |
| `npm view semver version` with `NPM_CONFIG_HTTPS_PROXY` set to the server and a temporary cache | `NPM_CONFIG_FETCH_TIMEOUT=5000`, `NPM_CONFIG_FETCH_RETRIES=0` | no end in 45 s |

So the low speed limit of git applies after the connection, when git waits for the answer to its request. It does not
apply while git waits for the answer of a proxy to `CONNECT`. git has no setting for the connect time of HTTPS, and the
time limit of npm does not apply there either.

### What the user sees, by the kind of failure

| Failure | Today | With this change |
| --- | --- | --- |
| No network: the name `github.com` does not resolve | HTTPS and SSH fail at once, exit code 128, no message in the IDE (README) | the same; `install` told the user before |
| A transfer that stalls after the connection | no end found | HTTPS ends after 20 s with no second run, then the SSH fallback |
| A proxy that accepts and never answers `CONNECT` | no end in 180 s (README) | the same; only the time limit of the IDE helps |
| A network that drops the packets of the connection | not measured | the same; only the time limit of the IDE helps |
| An IDE build without the Air support | no sign | the line of `install` before, and one line in the log of the IDE |

## Goals / Non-Goals

**Goals:**

- End each stall that git can end with the settings that it reads from the environment.
- Tell the user, before the first start, what the start needs and what a failed start looks like.
- Leave a sign of a client without the Air support where a bug report finds it.
- Keep the environment of the daemon and its children as the IDE gives it.

**Non-Goals:**

- A guard for a stall that git and npm cannot end. That is the Air side.
- A change of the source of the release (`#semver:x`), of the release script or of the files of the package.

## Decisions

### 1. Two variables of git in the env of the entry

`GIT_HTTP_LOW_SPEED_LIMIT=1000` and `GIT_HTTP_LOW_SPEED_TIME=20`. The answer of `git ls-remote` for this repository is
a few kilobytes, so a working connection of 1 KB per second does not reach the limit. With 20 seconds and no second run
for "Operation too slow", the HTTPS part of a stalled transfer ends after about 20 seconds. The values are strings,
because `env` of `acp.json` holds strings. The entry of a git checkout gets no `env`: it does not start npx.

Alternatives:

- **`GIT_SSH_COMMAND` with `-oConnectTimeout=10`.** It would end the SSH fallback of npm in a network that drops the
  packets of port 22: 3 runs of 10 seconds instead of 3 runs of the TCP time limit of the system. But a value in the
  environment replaces the `core.sshCommand` of the user for this git command, and the HTTPS URL comes first for this
  public repository. So the change leaves it out. A later change can add it after the manual check 5.3.
- **A wrapper command around npx**, such as `sh -c` with a timer. The IDE starts the command `npx` with its own Node.js
  and npm cache. Another command loses them, and macOS has no `timeout` command.
- **`NODE_OPTIONS` with a watchdog module in the env.** Each Node.js process of the start, also Megachat, its daemon
  and each child, loads the module, and npx stays the parent of `acp` while Megachat runs. A watchdog cannot tell a
  stalled npx from a running Megachat.
- **An entry from a tarball of a GitHub release.** npm downloads a tarball with its own HTTP client, and the probe
  shows that its time limit also does not end a stalled proxy. It also changes the release and the update. Left out.

### 2. The removal of the variables from the daemon and its children

`withoutNpm` in `src/npmEnvironment.mjs` removes the two variables only when npm started the process and each variable
has exactly the value of the entry. The module that holds the entry exports the values, so one place holds them. A
value of the user stays. After a direct start, the environment stays as it is.

### 3. The replacement of the entry of install 0.3.0

`install` 0.3.0 wrote exactly `{"command":"npx","args":["-y","github:ignatov/megachat#semver:x","acp"]}`. In a copy
without `.git`, the function that accepts a replaceable entry accepts the entry of 0.2.0 and this entry. The write
keeps the copy of the file, the place of the entry, the other keys and the mode, as for the entry of 0.2.0. The line is
the new message `install.replacedEarlier`, because the message of 0.2.0 says that the earlier entry started a copy
with Node.js. An entry with another key, such as an `env` of the user, stays a different entry: `install` changes
nothing and exits with 1. In a git checkout, the entry of 0.3.0 stays a different entry, as today.

### 4. The lines of install

- `install.network`, only in a copy without `.git`, directly before `install.ide`.
- `install.air`, in each copy, directly before `install.ide` in a copy and before `install.copy` in a checkout.
- The order of the last lines does not change, so the requirement "Last lines and exit code of install" keeps its
  text. The change `show-build-version` modifies that requirement, so this change does not.

`install` cannot check the IDE build. It runs in a terminal, it finds no running IDE, and no build number with the Air
support is known: only a build from the current sources of the IDE has it.

### 5. The line of a client without the Air support

`AcpBridge` reads `clientCapabilities._meta.jetbrains.air` in `initialize` today. When the version is not 1 or more,
it writes the message `log.noAir` to the error output of `acp` one time for each connection. The IDE keeps the error
output of an agent in its log; task 5.6 checks where. The answer to `initialize` and the other ACP messages stay the
same.

### The state, the daemon and the ACP messages

- No field of `conversation.sqlite`, `settings.json` or another state file changes. An older state directory needs no
  migration. `acp.json` gets the key `env` in the entry; `install` writes it.
- The daemon keeps the admitted work through a disconnect and a restart as today. The variables of the entry do not
  reach the daemon, so a restart of the daemon by another client gets the same environment.
- ACP: no new message and no new `_meta` key. `initialize` reads `_meta.jetbrains.air` as today.

## Risks / Trade-offs

- [The IDE does not pass the `env` of `acp.json`] → The variables do nothing, and nothing breaks. Task 5.4 checks it.
- [A slow network ends a start that would succeed] → 1000 bytes per second for 20 seconds is far below a working
  network. The npm download of the tarball and of the dependencies does not use the variables.
- [A user keeps a hand-edited entry] → `install` changes no entry with another key, and it prints both entries.
- [The line about the network sounds alarming] → It states the known behavior of the README and what to do.
- [The proxy case of issue #38 stays open on the Megachat side] → The proposal says so, and the Air side gets the
  request for a time limit.

## Migration Plan

The next `install` of a copy replaces the entry of 0.3.0, with a copy of the file. A user who does not run `install`
again keeps the entry without `env`, which works as today. A rollback is a revert of the commit: `install` of the
earlier code then calls the entry with `env` a different entry and does not change it.
