## MODIFIED Requirements

### Requirement: Automatic continuation
An interrupted run MUST continue automatically unless the user cancelled it or it reached a limit. An agent that cannot use an HTTP MCP server or cannot load a session MUST end its run with that reason, without a continuation. An agent that answers with the ACP error `authRequired` MUST end its run without a continuation, because a login does not come back by itself.

Tests: `test/state.test.mjs`, `test/integration.test.mjs`, `test/error-output.test.mjs`

#### Scenario: A cancelled run and a limited run
- **WHEN** the user cancelled one dispatched run, another run is interrupted at a limit, and the recovery runs
- **THEN** the cancelled run stays `cancelled`, the limited run stays `interrupted`, and neither run gets a continuation

#### Scenario: An agent without an HTTP MCP server
- **WHEN** the agent of a child does not accept an HTTP MCP server
- **THEN** the run becomes `interrupted` with the error "The agent does not accept an HTTP MCP server, so it cannot read the Megachat history.", the agent gets no prompt, and no continuation starts

#### Scenario: An agent without a login
- **WHEN** the agent answers `session/new` with the ACP error `authRequired`
- **THEN** the run becomes `interrupted` with `autoResume` false, and no continuation starts
