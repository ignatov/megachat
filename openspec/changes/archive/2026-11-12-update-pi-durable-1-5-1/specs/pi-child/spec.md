## MODIFIED Requirements

### Requirement: Model of a pi child
A pi child MUST use the model of the setting `children.piModel`, `provider/model`, which the model registry MUST know. The default is `anthropic/claude-haiku-5-5`.

The setting `cache.ttl` applies to the requests of a pi child too. Pi Durable 1.5.1 reads the stream options of the harness without the conversation, so a child cannot get a cache lifetime of its own without a rewrite of the provider request.

Tests: `test/settings.test.mjs`

#### Scenario: The default value
- **WHEN** no value of `children.piModel` is stored
- **THEN** the setting gives `anthropic/claude-haiku-5-5`

#### Scenario: A value that is not a known model
- **WHEN** the registry has only the `faux` models
- **THEN** the setting accepts `faux/fast` and refuses `anthropic/claude-haiku-5-5`, `small` and `faux/`

### Requirement: Conversation of a pi child after the prune
Pi Durable 1.5.1 cannot delete or archive a conversation. So `conversation.sqlite` MUST keep the conversation of a pi child after the prune drops its last run.

#### Scenario: The last run goes
- **WHEN** the prune drops the last run of a pi child
- **THEN** `conversation.sqlite` still holds the conversation of that child
