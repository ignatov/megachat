# Spec Delta

## MODIFIED Requirements

### Requirement: Meaning of the step values
`allow` MUST let the child do the step. `deny` MUST forbid the step, also when the task asks for it. `ask` MUST forbid the step unless the task says that the user approved it. The child MUST then say in its result that the step is necessary. For a Claude child, a permission rule also guards a commit and a push (see "Permission rules of the steps").

Tests: `test/child-settings.test.mjs`

#### Scenario: The value ask
- **WHEN** `children.commit` is `ask`
- **THEN** the rules paragraph tells the child to make a git commit only when the task says that the user approved the commit, and else to say in its result that a commit is necessary

#### Scenario: The value deny
- **WHEN** `children.push` is `deny`
- **THEN** the rules paragraph tells the child not to push to a remote repository, also when the task asks for it

## ADDED Requirements

### Requirement: Permission rules of the steps
At each start of a session of a Claude child, `deny` of `children.push` MUST add `Bash(git push:*)` to `disallowedTools` of `_meta.claudeCode.options`, and `ask` MUST add it to `permissions.ask` of `settings` of those options. `children.commit` MUST do the same with `Bash(git commit:*)`. `allow` MUST add no rule. One map in `src/Settings.mjs` MUST hold the patterns.

Tests: `test/child-settings.test.mjs`

#### Scenario: The defaults
- **WHEN** `children.commit` is `allow`, `children.push` is `ask`, and a Claude child starts
- **THEN** its options hold `settings` `{"permissions":{"ask":["Bash(git push:*)"]}}` and no `disallowedTools`

#### Scenario: Two values deny
- **WHEN** `children.commit` and `children.push` are `deny`, and a Claude child starts
- **THEN** its options hold `disallowedTools` `["Bash(git commit:*)","Bash(git push:*)"]` and no `settings`

#### Scenario: A follow-up after a change
- **WHEN** a turn sets `children.push` to `allow` for the project of a Claude run, and sends a follow-up to its session
- **THEN** the load of the session holds no rule for `git push`

### Requirement: Sources of the permission rules
The rules MUST come from the effective values of the directory of the run, with its project value (see the capability `project-settings`). A Codex child and a pi child MUST get no permission rule. The rules MUST NOT remove a rule of the settings of the user, of the project or the local settings.

Tests: `test/child-settings.test.mjs`

#### Scenario: A project value
- **WHEN** `children.push` is `ask`, the project value of the directory of the run is `deny`, and a Claude child starts there
- **THEN** its options hold `disallowedTools` `["Bash(git push:*)"]`

#### Scenario: A Codex child
- **WHEN** `children.push` is `deny` and a task goes to `codex`
- **THEN** the `session/new` request of the Codex child has no `_meta.claudeCode`

### Requirement: Limits of the permission rules
The guard MUST be described as a best effort. Claude Code checks deny rules, then ask rules, then allow rules, so a rule of Megachat wins over an allow rule of the user. A rule matches only a command that starts with `git push` or `git commit`. The descriptions of `children.commit` and `children.push` MUST say that a child can still push or commit in another way, such as `git -C`.

Tests: `test/child-settings.test.mjs`

#### Scenario: The description in get
- **WHEN** `agents_settings get` gives the setting `children.push`
- **THEN** its description says that a Claude child gets a permission rule for a command that starts with `git push`, and that this is no full guard
