## MODIFIED Requirements

### Requirement: Failed reply
A reply that fails on a model error MUST tell the user "The model did not answer. Send the message again." A reply that fails on a cause of Central MUST tell the text of that cause instead (see the requirement "Text of a failure of Central"). The state MUST keep only the reason code and the cause code of a failed reply, not the error text of the provider and not the output of the Central command.

Tests: `test/integration.test.mjs`, `test/failure.test.mjs`

#### Scenario: A reply to the user that fails on a model error
- **WHEN** the model fails on the reply to the message "Hello"
- **THEN** the user sees "The model did not answer. Send the message again.", and the prompt ends with the stop reason `cancelled`

#### Scenario: A result report that fails on a model error
- **WHEN** the model fails on a result report with the error text "The provider is overloaded."
- **THEN** the report has the status `interrupted` and the reason `model_error`, and the state holds no text "overloaded"

#### Scenario: A reply that fails with the HTTP status 529
- **WHEN** Central answers the model request of the reply to "Hello" with the HTTP status 529
- **THEN** the user sees "The model did not answer. Send the message again.", and the input has no cause code

#### Scenario: The cause code in the state
- **WHEN** the reply to "Hello" fails because the local proxy of Central refuses the connection, and the configuration of Central holds the key "sk-secret-value"
- **THEN** the input has the reason `model_error` and the cause `central_proxy`, and the state holds no text "sk-secret-value", "ECONNREFUSED" or "Connection error"

## ADDED Requirements

### Requirement: Text of a failure of Central
Megachat MUST tell apart these causes: no command `~/.local/bin/central` (`central_missing`); a failed `central run pi`, its time limit of 15 s, or a configuration that it cannot use (`central_command`); a refused connection to the local proxy (`central_proxy`); another request with no response (`central_unreachable`); the HTTP status 401 or 403 (`central_refused`). Each text MUST name a command for the next step.

Tests: `test/failure.test.mjs`

#### Scenario: A missing Central command
- **WHEN** the command `~/.local/bin/central` does not exist, and the user sends "Hello"
- **THEN** the user sees "Megachat cannot find the JetBrains Central CLI at ~/.local/bin/central. Install it, run `central login` in a terminal, and then send the message again."

#### Scenario: A Central command that fails
- **WHEN** the Central command prints "Not logged in" and exits with the code 1, and the user sends "Hello"
- **THEN** the user sees "JetBrains Central gave Megachat no configuration. Run `central login` in a terminal. When you are logged in, run `central repair`. Then send the message again."

#### Scenario: A local proxy that refuses the connection
- **WHEN** the configuration of Central gives a local address where nothing listens, and the user sends "Hello"
- **THEN** the user sees "Megachat cannot connect to the local proxy of JetBrains Central. Run `central proxy start` or `central repair` in a terminal, and then send the message again."

#### Scenario: A connection that the proxy resets
- **WHEN** the local proxy of Central accepts the connection of the model request and closes it before a response, and the user sends "Hello"
- **THEN** the user sees "Megachat got no response from JetBrains Central. Check the network, or run `central repair` in a terminal. Then send the message again."

#### Scenario: A request that Central refuses
- **WHEN** the local proxy of Central answers the model request with the HTTP status 401, and the user sends "Hello"
- **THEN** the user sees "JetBrains Central refused the request of the model. Your Central login can have expired. Run `central login` in a terminal, and then send the message again."

#### Scenario: A cause of an earlier turn
- **WHEN** a model request through a refused connection failed in an earlier turn, and the next reply fails with the HTTP status 529
- **THEN** the user sees "The model did not answer. Send the message again."
