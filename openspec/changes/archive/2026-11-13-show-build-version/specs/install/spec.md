# Spec Delta

## MODIFIED Requirements

### Requirement: Last lines and exit code of install
The last line of `install` MUST give the version of the build (see the capability `launch`) and the directory of the copy. In a copy without `.git`, a line before it MUST say that the IDE starts Megachat with `npx` and its own Node.js. The last line MUST say that the IDE uses a copy of its own.

The exit code MUST be 0 only when the entry is in place and each check passed.

Tests: `test/install.test.mjs`

#### Scenario: Install in a copy
- **WHEN** `install` runs in a copy without `.git` on macOS, and each check passes
- **THEN** `install` prints "The IDE starts Megachat with npx and with its own Node.js, not with the Node.js of this terminal.", the last line is "This install ran Megachat" with the version and the directory, followed by "The IDE uses a copy of its own in its npm cache.", and the exit code is 0

#### Scenario: Install in a checkout after the release tag
- **WHEN** `install` runs in a temporary git repository with the version `0.3.0`, the tag `v0.3.0` and two commits after it
- **THEN** the last line is "Megachat 0.3.0+2.g" with the first 7 hexadecimal digits of the commit, followed by "runs from" and the directory

#### Scenario: A failed check
- **WHEN** `install` writes the entry, but `codex` is not on the `PATH`
- **THEN** the exit code is 1
