# Spec Delta

## MODIFIED Requirements

### Requirement: Pending onboarding
Without `settings.json`, the onboarding MUST be pending. The rules of the main agent MUST then hold the setup rules of `resources/instructions-onboarding.md`. In a project scope, they MUST hold the setup rules of `resources/instructions-onboarding-project.md` in their place (see the capability `project-scope`).

Tests: `test/settings.test.mjs`, `test/project-scope.test.mjs`

#### Scenario: No settings file
- **WHEN** the state directory has no `settings.json`
- **THEN** `agents_settings get` gives the onboarding `pending`, and the rules hold "The setup of Megachat is pending."

#### Scenario: No settings file in a project scope
- **WHEN** the state directory of the project `app` has no `settings.json`
- **THEN** `agents_settings get` gives the onboarding `pending`, the rules hold "The setup asks the user two questions", and they do not hold `projects.newRoot`
