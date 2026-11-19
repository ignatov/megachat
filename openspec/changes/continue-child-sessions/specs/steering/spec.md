## MODIFIED Requirements

### Requirement: Tool agents_steer
The tool `agents_steer` of the main agent MUST add a message of the user to the unfinished run of a child session, without a wait for the end of the task. Its description MUST name information, a correction and the next step of that task, and the task MUST keep one result. `agents_send` MUST stay a follow-up to an idle child session. Its refusal for a child that works MUST name `agents_steer`.

Tests: `test/integration.test.mjs`, `test/pi-child.test.mjs`, `test/continue-sessions.test.mjs`

#### Scenario: A message to a child that works
- **WHEN** a child works on the task `steer` and the main agent calls `agents_steer` with the text "Use https://example.com/a"
- **THEN** the outcome is `injected`, the run becomes `completed` with the message in its output, and the main agent gets one report

#### Scenario: A follow-up to a child that works
- **WHEN** the main agent calls `agents_send` for a child that waits for a permission request
- **THEN** the tool gives an error, and the error names `agents_steer`

#### Scenario: The description of agents_steer
- **WHEN** a test reads the description of `agents_steer`
- **THEN** it holds "Use it when the user adds information, a correction or the next step of that task." and "The task keeps one result."
