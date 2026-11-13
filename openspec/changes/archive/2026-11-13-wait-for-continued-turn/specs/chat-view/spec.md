## ADDED Requirements

### Requirement: Prompt during a turn that the view does not know
When the daemon refuses a prompt with `busy`, for example while it continues a user turn after its restart, the prompt MUST wait for the end of that turn and then start its own turn. A Stop of the waiting prompt MUST end it with `cancelled`, with no input of the prompt, and it MUST stop the running turn.

Tests: `test/prompt-wait.test.mjs`

#### Scenario: A turn of the last daemon runs
- **WHEN** the user turn `Fix the lexer` runs, and the view sends the prompt `Fix the parser`
- **THEN** the state has no input of the prompt while the first turn runs, and after its end the prompt ends with `end_turn` and the reply `The parser reads each line now.`

#### Scenario: A Stop of the waiting prompt
- **WHEN** the prompt `Fix the parser` waits for the turn `Fix the lexer`, and the user stops it
- **THEN** the prompt ends with `cancelled`, the state has no input of the prompt, and the turn `Fix the lexer` ends

### Requirement: Prompt that loses its daemon
When the connection to the daemon ends after the daemon admitted a prompt, the prompt MUST end with `cancelled` and the notice `error.daemonLost`, not with the error of the connection. A prompt that finds no daemon MUST fail with the text `error.unavailable`.

Tests: `test/prompt-wait.test.mjs`

#### Scenario: The daemon stops during the turn
- **WHEN** the turn of the prompt `Fix the parser` runs, and the daemon closes its connections
- **THEN** the prompt ends with `cancelled`, and the chat shows the notice `error.daemonLost`

#### Scenario: No daemon at the prompt
- **WHEN** the daemon closed its connections, and the view sends the prompt `Fix the parser`
- **THEN** the prompt fails with the text `error.unavailable`
