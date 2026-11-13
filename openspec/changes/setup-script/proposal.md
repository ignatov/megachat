# Proposal

## Why

A colleague with an empty Mac must now do five manual steps before the install line works: install the Command Line
Tools for git, install Node.js 22.19 or later, install the Central command, run `central login`, and run
`central add claude-code`. An empty `~/.jetbrains/acp.json` also stops the install line. Each step is a place where a
colleague stops and asks. One line in the terminal must do all of them.

## What Changes

Where it shows: the terminal of the colleague, the assets of each GitHub release, and `README.md`.

- **A setup script `setup.sh`.** A colleague runs one line:
  `curl -fsSL https://github.com/ignatov/megachat/releases/latest/download/setup.sh | bash`. The script does these
  steps, prints one line for each step, and stops with a message at the first step that fails:
  1. It stops on a platform other than macOS.
  2. When `git --version` fails, it runs `xcode-select --install` and stops: install the Command Line Tools, then run
     the line again.
  3. When `node` on the `PATH` is 22.19 or later, it uses that Node.js. Else it downloads the Node.js archive of one
     pinned version for `darwin-arm64` or `darwin-x64` from `nodejs.org` into a new temporary directory, checks the
     archive with `SHASUMS256.txt`, and uses its `npx`. It uses no `sudo`, no Homebrew, and changes no file of the
     system. It leaves the temporary directory.
  4. When `~/.local/bin/central` is missing, it runs the official installer of Central.
  5. When `central status` shows no login, it runs `central login` on the terminal, and checks the login again.
  6. When `~/.claude/settings.json` has no Central entry, it runs `central add claude-code`.
  7. When `acp.json` is empty or holds only white space, it writes `{}`. Other content stays.
  8. It runs the install line `npx -y "github:ignatov/megachat#semver:x" install` and shows its output. The exit code
     of the install line is the exit code of the script.
  9. Its last lines tell what to do in the IDE: select Megachat in the agent list of Air. The IDE needs no restart.
- A second run on a ready machine changes no file and ends with the exit code 0. The script prints no key and no
  token.
- **The release attaches the script.** `npm run release` gives `setup.sh` of the release commit to
  `gh release create` as an asset. So the address `releases/latest/download/setup.sh` stays the same, and the script
  always comes from a tested release.
- **`README.md`**: "Install for a colleague" gives the one line and a short list: run the line, log in when Central
  asks, select Megachat in the agent list of Air. The IDE reads the change of `acp.json` itself, so it needs no
  restart. The present manual steps stay as a fallback section.

The change does not modify an ACP extension. Air does not change. `docs/air-contract.md` does not change.

## Capabilities

### New Capabilities

- `setup-script`: the setup script `setup.sh`: its platform, git, Node.js, Central, login, Claude key and `acp.json` steps,
  the install line that it runs, its last lines, its exit code, and its second run.

### Modified Capabilities

- `release`: the requirement "Steps of a release" changes. The GitHub release gets `setup.sh` as an asset.

## Impact

- `setup.sh`: the new script at the root of the repository. It is not in the npm package, because the package needs
  no copy of it.
- `release.mjs`: `releaseSteps()` gives `setup.sh` to `gh release create`.
- `test/setup.test.mjs`: a new test that runs the script with a temporary `HOME` and fake commands.
- `test/release.test.mjs`: the case of the steps expects the asset.
- `README.md`: "Install for a colleague" and "Releases".
- `resources/Megachat.properties` does not change. The script runs before Megachat is on the machine, so it cannot
  read that file (see design.md, D1).

## Out of scope

- `central add codex`. A Codex child works through `central run codex` without it. Without it, Central puts its base
  URL with the key in the command line of Codex (see `README.md`).
- A platform other than macOS.
- A check of the IDE build. The install line already says that it cannot check it.
- A Node.js in the system, a change of a shell file, and a change of the `PATH` of the user.
- The change keeps the non-goal "Megachat does not install a login service": the user logs in to Central in the
  terminal. The script only starts `central login`.
