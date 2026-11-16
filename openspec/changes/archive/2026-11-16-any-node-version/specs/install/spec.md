## MODIFIED Requirements

### Requirement: Check of the Node.js version
The command `megachat` MUST check the version of Node.js before it loads Megachat. A Node.js older than the `engines` range MUST get one line with the found and the needed version, and the exit code 1. Each Node.js from the minimum on MUST run Megachat. The range has no upper bound.

Tests: `test/install.test.mjs`, `test/setup.test.mjs`

#### Scenario: An old Node.js
- **WHEN** the `engines` range is `>=22.19`, and the command `megachat` runs on Node.js 22.18.3
- **THEN** the command writes only the line "Megachat needs Node.js 22.19 or later. This Node.js is 22.18.3." and exits with the code 1

#### Scenario: A new Node.js
- **WHEN** `setup.sh` finds Node.js 25.6.0 on the `PATH`
- **THEN** the script uses it and runs the install line without a download of Node.js

## ADDED Requirements

### Requirement: A failure has a reason
`install` and the launcher MUST NOT exit with the code 1 without a text. `install` MUST print a closing line when a check fails, and the message of an unexpected error with the hint `rm -rf ~/.npm/_npx`. The launcher MUST print the same hint and the error when `src/main.mjs` fails to load. The ExperimentalWarning of `node:sqlite` MUST NOT show; other warnings MUST show.

Tests: `test/install.test.mjs`

#### Scenario: A copy that fails to load
- **WHEN** `src/main.mjs` of a copy throws "broken copy"
- **THEN** the launcher writes "Megachat could not start on Node.js", the hint `rm -rf ~/.npm/_npx` and "broken copy" to the error output, and exits with the code 1

#### Scenario: A failed check
- **WHEN** `install` finds no Central
- **THEN** the last line of its output says that the install has a failed check, and it exits with the code 1

### Requirement: A log of the install line
`setup.sh` MUST write the output of the install line to the file `$TMPDIR/megachat-setup.log`, and to the screen. When the install line fails, it MUST print the path of the log, the last 20 lines of the log and the hint `rm -rf ~/.npm/_npx`, and exit with the code of the install line.

Tests: `test/setup.test.mjs`

#### Scenario: A failed install line
- **WHEN** the install line exits with the code 3
- **THEN** the script prints "The log is" with the path, the last lines and the hint, and exits with the code 3
