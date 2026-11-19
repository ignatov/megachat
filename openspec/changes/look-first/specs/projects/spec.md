# Spec Delta

## ADDED Requirements

### Requirement: Time of the addition of a directory
The state MUST keep the time when a directory came into the list: a project of an IDE at its first registration, a known repository at its add or create. `agents_list` and `agents_projects` MUST give it as `addedAt`, an ISO 8601 time in UTC. The workspace of Megachat and a directory that an older state listed MUST have no `addedAt`. A remove and a new add MUST give a new time. The description of `agents_list` MUST describe `addedAt`.

Tests: `test/projects.test.mjs`

#### Scenario: Two additions
- **WHEN** an IDE registers `outside` at `2026-11-19T09:00:00.000Z`, registers it again at `2026-11-19T09:00:15.000Z`, and the user adds `~/src/metrics` at `2026-11-19T10:00:00.000Z`
- **THEN** `agents_list` gives `outside` with `addedAt` `2026-11-19T09:00:00.000Z`, `~/src/metrics` with `addedAt` `2026-11-19T10:00:00.000Z`, and the workspace of Megachat without `addedAt`

#### Scenario: An older state and a new add
- **WHEN** a state of an older version lists the known repository `~/src/repository`, and the user removes it and adds it again at `2026-11-19T11:00:00.000Z`
- **THEN** before the remove `~/src/repository` has no `addedAt`, and after the new add it has `addedAt` `2026-11-19T11:00:00.000Z`

#### Scenario: The description of agents_list
- **WHEN** a test reads the description of `agents_list`
- **THEN** it holds "addedAt" and "the directory that the user added last"
