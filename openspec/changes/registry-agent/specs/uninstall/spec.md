# Spec Delta

## ADDED Requirements

### Requirement: Overlay entry at uninstall
After the work check, `uninstall` MUST remove the overlay entry `acp.registry.megachat-acp` that `install` wrote in a checkout, with a copy to `<file>.before-megachat-<UTC time>`, and keep each other entry. Another overlay entry, and a file that is not strict JSON (also one with comments), MUST stay.

Tests: `test/uninstall.test.mjs`

#### Scenario: The entry of a checkout next to another agent
- **WHEN** the overlay file has `acp.registry.claude-acp` and the entry of the checkout `/opt/megachat`
- **THEN** `uninstall` prints "Megachat removed the overlay entry of the registry agent Megachat", and the file has only `acp.registry.claude-acp`

#### Scenario: A file with comments
- **WHEN** the overlay file has a comment line and the entry of the checkout
- **THEN** the file stays unchanged, and the exit code is 0
