# Design

## Context

See proposal.md, "Why", for the problem. The present state:

- The install line `npx -y "github:ignatov/megachat#semver:x" install` needs git, Node.js 22.19 or later, the Central
  command at `~/.local/bin/central` and its login. Since commit cdf3488 it ends with the exit code 0 with only Central
  and its login, because a child uses the Claude and Codex binaries that npm installed with Megachat.
- `writeEntry()` of `src/MegachatInstall.mjs` reads `acp.json` as JSON. An empty file gives `unreadable`, and the
  install line changes nothing. A missing file gives `created`.
- `acpConfigPath()` gives the file of `MEGACHAT_ACP_CONFIG` when the variable is set, else `~/.jetbrains/acp.json`.
- `releaseSteps()` of `release.mjs` ends with `gh release create <tag> --verify-tag --title ... --notes-file -`.

Facts from a clean macOS 26.6.2 virtual machine with Central 2.5.0 and no Claude Code (2026-11-13). No key was printed:

1. `central add claude-code` works without a Claude Code CLI. It exits with 0, writes `apiKeyHelper` and
   `env.ANTHROPIC_BASE_URL` into `~/.claude/settings.json`, and writes a backup next to the file. Without a login it
   prints "not logged in — run 'central login' first" and exits with 1.
2. Its key helper calls a bare `central`. Megachat puts the directory of the Central command on the `PATH` of the
   helper (commit cdf3488), so the script changes no shell file.
3. `central status` exits with 0 also without a login. Its text then has a line with `Auth` and `not connected`. With
   a login the line is `Auth  JetBrains Team`, or the name of another source.
4. `central login` uses bubbletea and fails without a terminal.
5. `/usr/bin/git` of macOS fails until the Command Line Tools are installed, and `npx github:...` runs git at each
   start.

## Goals / Non-Goals

**Goals:**

- One line on an empty Mac gives a working Megachat, with only the login as an interactive step.
- A second run on a ready machine changes nothing.
- The tests run the script without the network, the real `HOME`, the real Central and the real `acp.json`.

**Non-Goals:**

- A Node.js in the system, a change of a shell file, `sudo`, or Homebrew.
- A removal of the temporary directory of the downloaded Node.js.

## Decisions

### D1. The texts of the script stay in the script

The rule of the project puts each user-visible string in `resources/Megachat.properties`. The script runs before
Megachat is on the machine: `curl | bash` gives bash only the script, and no copy of Megachat or Node.js is there yet
to read the file. So the texts of the script are in `setup.sh`, and this design records the exception. The texts are
in ASD-STE100 Simplified Technical English, as each other text. Each line starts with `[megachat setup]`, so that the
user can tell the lines of the script from the output of the installer of Central, of `central login` and of the
install line.

Alternative: a second download of the properties file. Rejected: a second address that can fail, for no gain.

### D2. The address is a release asset

`releaseSteps()` gives `setup.sh` to `gh release create` as the last argument, so the GitHub release gets it as an
asset with the name `setup.sh`. `releases/latest/download/setup.sh` then gives the script of the last release. The
release builds and tests the commit before the tag, so the script always comes from a tested release, and the script
and the install line `#semver:x` select the same release.

Alternative: `raw.githubusercontent.com/ignatov/megachat/main/setup.sh`. Rejected: a commit on `main` that no release
holds would reach a colleague at once.

The script is at the root of the repository. It is not in the `files` of `package.json`, because the package needs no
copy of it. The requirement "Content of the package" of the capability `install` does not change.

### D3. The script runs from a pipe

`curl | bash` gives bash the script on its standard input, and bash reads the script while it runs it. So:

- All the code is in the function `main`, and the last line calls it. Bash runs no step before it read the whole
  script, and a part of a download runs nothing.
- Each command that does not ask the user reads `/dev/null`, so it cannot take the rest of the script from the pipe.
- `central login` reads the terminal. The file is `/dev/tty`, or the file of `MEGACHAT_SETUP_TTY` when the variable is
  set. The tests set it, because a test has no terminal. When the script cannot open the file, it stops with a
  message.

The script is for `/bin/bash` 3.2 of macOS: no arrays with `set -u`, no `[[ =~ ]]` with a capture, no `declare -A`, no
`${var,,}`. It uses no `set -e`: each step checks its exit code itself.

### D4. Node.js

The script reads `node --version` and compares the major and minor numbers with 22.19. When the `node` and `npx` of
the `PATH` are new enough, the install line runs with that `npx`. Else the script downloads Node.js 24.22.3, the last
LTS release on 2026-11-13. The IDE runs Node.js 24.22.1, so this is the same major version.

- The archive is `node-v24.22.3-darwin-arm64.tar.gz`, or `node-v24.22.3-darwin-x64.tar.gz` when `uname -m` gives
  `x86_64`. The base address is `https://nodejs.org/dist/v24.22.3/`.
- The script downloads the archive and `SHASUMS256.txt` into a new directory of `mktemp -d`, takes the line of the
  archive from `SHASUMS256.txt`, and compares it with `shasum -a 256` of the archive. A difference, or no line, stops
  the script.
- It extracts the archive with `tar -xzf` in the same directory, and puts its `bin` first on the `PATH` of the install
  line. `npx` starts with `#!/usr/bin/env node`, so it needs that `node` first on the `PATH`.
- The script leaves the directory, because the project does no recursive delete. macOS removes old files of the
  temporary directory itself.

The version is a constant in the script, so two runs get the same Node.js. Alternative: the hashes as constants in the
script. Rejected by the user: `SHASUMS256.txt` comes over HTTPS from the same server, and a new version then needs
only one constant.

### D5. Central and its login

The script uses the path `~/.local/bin/central`, the path of the installer of Central and of Megachat, and not a
`central` of the `PATH`. When the file is not executable, the script runs
`curl -fsSL https://central-cli.labs.jb.gg/install.sh | bash`, and checks the file again.

`central status` exits with 0 also without a login (fact 3), so the script reads its text: a line with `Auth` and
`not connected` means no login. Then it runs `central login` with the terminal as input (fact 4), and reads
`central status` again. A failure of `central status` itself also counts as no login.

### D6. The Claude key

`central add claude-code` writes `~/.claude/settings.json` and a backup at each run (fact 1). So the script runs it
only when the file has no `"apiKeyHelper"` with `central` in its value, or no `"ANTHROPIC_BASE_URL"`. The script
searches the text of the file with `grep`, because a fake `node` of the tests and a downloaded Node.js must not change
the result. Without this check, a second run would write a new backup.

When `central add claude-code` fails, the script says so and goes on: the install line does not need the entry, and a
Claude child then uses the pi route of Central. The script runs no `central add codex` (see proposal.md, "Out of
scope").

### D7. acp.json

The file is the file of `MEGACHAT_ACP_CONFIG`, else `~/.jetbrains/acp.json`, the same rule as `acpConfigPath()`. When
the file exists and `grep` finds no character other than white space, the script writes `{}` and a line break. The
redirection keeps the mode of the file. The script reads no other field of the file, and it changes no other content.

### D8. No secret in the output

The output of `central status` and of `central add claude-code` stays in a shell variable and is not shown, because
the base URL of Central holds a key. The script shows the output of the installer of Central, of `central login`
(the user needs its address and code) and of the install line. These print no key.

### D9. The test

`test/setup.test.mjs` runs `bash` with the script on its standard input, as `curl | bash` does. Its `PATH` has a
directory of fake commands first: `uname`, `git`, `xcode-select`, `node`, `npx`, `curl` and `shasum`. The fake `curl`
gives the files of the test for `nodejs.org` and for the installer of Central. The installer of the test writes a fake
`central` to `$HOME/.local/bin`. Each fake command writes its arguments to a log file of the test. `HOME` is a
temporary directory. `MEGACHAT_ACP_CONFIG` is a file of the test, and `MEGACHAT_SETUP_TTY` is a file of the test. So
the test reaches no network, no real Central and no file of the user. The real `tar`, `grep`, `awk` and `mktemp` of
the system run. The test leaves its temporary directories.

State files: the script reads `~/.claude/settings.json` (`apiKeyHelper`, `env.ANTHROPIC_BASE_URL`) and `acp.json`.
It adds no field. It reads and adds no field of `conversation.sqlite` or of the state directory of Megachat, and no
ACP message or `_meta` key. The daemon does not run during the script, so a disconnect of the ACP client does not
apply.

## Risks / Trade-offs

- [The text of `central status` changes in a later Central] → Without a line with `Auth` and `not connected`, the
  script takes the login as present, and `central add claude-code` and the install line then report the missing
  login.
- [A user has an own `apiKeyHelper` in `~/.claude/settings.json` without `central`] → `central add claude-code`
  replaces it, and Central keeps a backup next to the file.
- [A second run without a `node` of 22.19 or later downloads Node.js again] → It goes into a new temporary directory,
  and the script changes no other file.
- [nodejs.org removes Node.js 24.22.3] → The download fails with a message. A release with a new constant repairs it.
- [`xcode-select --install` opens a dialog] → The script stops, and the user runs the line again after the install.
