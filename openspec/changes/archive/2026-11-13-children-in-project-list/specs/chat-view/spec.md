## MODIFIED Requirements

### Requirement: Service sessions of delegated children
New delegated sessions MUST be service sessions when the client supports their registration, except a session in a directory where `children.showInProject` is `true`. The ordinary session list MUST hide these sessions. The daemon MUST retain their histories. Continuing an existing user session MUST preserve its visibility in the ordinary session list. Reconnection MUST mark earlier delegated sessions too.

Tests: `test/integration.test.mjs`

#### Scenario: A new Codex child
- **WHEN** a client that supports the registration of service sessions asks for work, and the main agent starts a Codex child
- **THEN** the client gets a registration with the agent `codex` and the provider session ID of the run

#### Scenario: A resume of an existing user session
- **WHEN** the main agent calls `agents_resume` for the Codex session `active`
- **THEN** the run has `serviceSession` false, and the client gets no registration

#### Scenario: A reconnection and a client without the support
- **WHEN** a second view with the support attaches after a Claude child ended, and a third view without the support attaches
- **THEN** the second view gets the registration of the session of the child again, and the third view gets no registration

#### Scenario: A project with children.showInProject
- **WHEN** `children.showInProject` is `true` for the directory of a new Codex child, and two views with the support attach
- **THEN** the run has `serviceSession` false, the state holds no address of it, and no view gets a registration
