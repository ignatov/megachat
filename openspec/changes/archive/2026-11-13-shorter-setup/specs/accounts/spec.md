## MODIFIED Requirements

### Requirement: When the check runs
The setup MUST run the check at its end as no question. It MUST show only the agents with a problem and what to fix, and say nothing about the check when each agent is ready. The rules of the main agent MUST run the check when a child fails with a login error.

Tests: `test/settings.test.mjs`

#### Scenario: The end of the setup
- **WHEN** a test reads `resources/instructions-onboarding.md`
- **THEN** it holds "call agents_accounts" and "Show only the agents with a problem and what to fix. When each agent is ready, say nothing about the check."
