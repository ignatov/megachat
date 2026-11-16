# Proposal

## Why

On 2026-11-16 a colleague ran the setup line on macOS with Node.js 25.6.0 on the `PATH`. All checks of `setup.sh`
passed. Then the install line printed only `npm warn deprecated node-domexception@1.0.0` and exited with the code 1.
No error text showed. The install worked after `rm -rf ~/.npm/_npx` and a run with Node.js 24.

The author asked: "start on any Node.js, from 22 and later".

Finding: Megachat 0.8.0 installs and runs on Node.js 25.6.0 with a clean and with a stale npm cache (checked with the
official darwin-arm64 build, a temporary `HOME` and a temporary npm cache). The code has no upper bound of the
version. Two things are wrong:

- On Node.js 22 to 25.6, `node:sqlite` prints an ExperimentalWarning on the error output. It hides the lines of
  `install`, and two tests of `install` that expect an empty error output fail on Node.js 25.6.
- A failure of the install line can leave no reason on the screen: `install` exits with 1 after its lines with no
  closing line, `setup.sh` shows no log, and a failed load of Megachat has no text of its own.

The silent failure of the colleague did not reproduce, so the cause is not proven. A stale `_npx` directory is the
suspect. The change makes the next such failure visible, and it names the fix.

## What Changes

Where it shows: the output of the install line and of `setup.sh`, and the README.

- `install` prints a closing line when it exits with 1, and an unexpected error of `install` prints its message with
  the hint `rm -rf ~/.npm/_npx`.
- The launcher prints the reason and the same hint when `src/main.mjs` fails to load.
- Megachat drops the ExperimentalWarning of `node:sqlite` only.
- `setup.sh` writes the output of the install line to `$TMPDIR/megachat-setup.log`. On a failure it prints the log
  path, the last 20 lines and the hint.
- The README states Node.js 22.19 or later, with no upper bound, and has a troubleshooting line.

## Capabilities

Modified: `install`.

## Impact

No ACP extension changes, so Air needs no change. The release `setup.sh` comes from `releases/latest`, so the fix
of the script needs a new release. The daemon needs no restart for the install path. A running daemon keeps the old
code until its next restart.

## Out of scope

A Node.js older than 22.19. A change of the `engines` range. A change of the dependencies.
