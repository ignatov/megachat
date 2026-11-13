## MODIFIED Requirements

### Requirement: Settings that can have a project value
A setting of one child run MUST be able to have a value for one project. `PROJECT_SETTINGS` of `src/Settings.mjs` MUST hold the list of these settings, and the scenario below names them. Each other setting applies to the daemon as a whole, also `children.parallel`, so it MUST have only the global value.

Tests: `test/project-settings.test.mjs`

#### Scenario: The list of the settings
- **WHEN** a test reads `PROJECT_SETTINGS`
- **THEN** it holds `children.agent`, `children.piModel`, `children.claudeModel`, `children.codexModel`, `children.permissionMode`, `children.commit`, `children.push`, `children.daemonRestart`, `children.timeoutMinutes` and `children.showInProject`, and the only other setting of the children, `children.parallel`, is not in the list

#### Scenario: A stored project value of children.parallel
- **WHEN** `settings.json` holds the value `1` of `children.parallel` for the project `lib`
- **THEN** a child run in `lib` gets the global value `3`
