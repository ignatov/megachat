# Spec Delta

## MODIFIED Requirements

### Requirement: Only an orphan
Megachat MUST stop only an orphan, or a session of a terminal or a multiplexer that the user archives (see the capability `session-archive`). Another session with a live owner, such as an IDE, a terminal, a multiplexer or a Megachat run, MUST be refused with the name of its owner, so the user stops it through the owner. A session in the state `unknown` and a PID that is no agent session MUST be refused too.

Tests: `test/stop.test.mjs`, `test/archive.test.mjs`

#### Scenario: A session with a live owner
- **WHEN** the main agent calls `agents_stop` with the PID 20 of a session in `IntelliJ IDEA 2026.3 EAP`, and the PID 51 of a session in `tmux`
- **THEN** each PID is refused with the name of its owner

#### Scenario: A session in the state unknown and no session
- **WHEN** the main agent calls `agents_stop` with the PID 12 of a session below a `java` process that is no sure IDE, and the PID 4242 that is no agent session
- **THEN** both PIDs are refused

#### Scenario: An archived terminal session
- **WHEN** the user answers `archive` for the PID 51 of an idle session in `tmux`
- **THEN** the PID 51 gets SIGTERM
