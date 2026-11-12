# keep-alive Specification

## Purpose
The main agent asks for a long prompt cache. The idle daemon keeps that cache warm with small keep-alive requests, or it writes the summary of a large context before the cache expires.

## Requirements

### Requirement: Prompt cache lifetime
Each request of the main agent MUST ask for the 1-hour prompt cache. `MEGACHAT_CACHE_TTL=5m` MUST ask for the 5-minute prompt cache.

Tests: `test/keepalive.test.mjs`

#### Scenario: The default lifetime
- **WHEN** the user sends a message and no variable is set
- **THEN** the model request asks for the cache retention `long`, and the cache lifetime is 1 hour

#### Scenario: The 5-minute lifetime
- **WHEN** `MEGACHAT_CACHE_TTL` is `5m`
- **THEN** the model request asks for the cache retention `short`, and the cache lifetime is 5 minutes

### Requirement: Time of the idle action
The idle daemon MUST act at 5/6 of the cache lifetime after the last model request. It MUST NOT act while a turn runs. A turn MUST stop a keep-alive request that runs.

Tests: `test/keepalive.test.mjs`

#### Scenario: The first keep-alive request
- **WHEN** the cache lifetime is 1 hour and a turn ends
- **THEN** no request goes out for 50 minutes less 1 millisecond, and a keep-alive request goes out at 50 minutes

#### Scenario: A turn during the idle time
- **WHEN** a turn starts 40 minutes after the end of the last turn and runs for 3 hours
- **THEN** no keep-alive request goes out during the turn, and the next request goes out 50 minutes after the end of that turn

#### Scenario: A turn during a keep-alive request
- **WHEN** a keep-alive request runs and a turn starts
- **THEN** the turn stops the keep-alive request

### Requirement: Summary or keep-alive request
When the model context is above the limit of a summary at that time, the daemon MUST write the summary, and it MUST send no keep-alive request. When the model context is between 20,000 tokens and that limit, the daemon MUST send a keep-alive request. The request MUST hold the model context as a turn sends it, and it MUST ask for one output token. The conversation MUST NOT get its reply.

Tests: `test/keepalive.test.mjs`

#### Scenario: A context above the limit
- **WHEN** the limit of a summary is 100,000 tokens and the idle context has 150,000 tokens
- **THEN** the daemon writes a summary at 50 minutes and sends no keep-alive request

#### Scenario: A small context
- **WHEN** the idle context has 19,999 tokens
- **THEN** the daemon sends no request

#### Scenario: The content of a keep-alive request
- **WHEN** the daemon sends a keep-alive request after two turns
- **THEN** the request has the session and the thinking level of the turns and the maximum of 1 output token, and the model context and the history do not change

### Requirement: Last message of a keep-alive request
An idle context ends with a message of the assistant: the last reply, or a note about the waiting sessions. Claude Opus 5.5 refuses a request that ends with a message of the assistant ("This model does not support assistant message prefill"). So when the context does not end with a message of the user, the keep-alive request MUST end with a short user message of its own after the context, from `keepalive.prompt` in the resources.

Tests: `test/keepalive.test.mjs`

#### Scenario: A context that ends with the last reply
- **WHEN** the model context ends with the last reply of the assistant, and the daemon sends a keep-alive request
- **THEN** the request has one message more than the model context, and its last message is a user message with the text of `keepalive.prompt`

### Requirement: Cache read with the keep-alive message
The conversation MUST NOT get the short user message from `keepalive.prompt`. It comes after the cached prefix, so the request still reads the context from the cache. A real run through Central on 2026-11-12 showed the refusal without that message, and a cache read of the whole context with it.

Tests: `test/keepalive.test.mjs`

#### Scenario: The model context after the keep-alive message
- **WHEN** a keep-alive request ends with the user message from `keepalive.prompt`
- **THEN** the request reads more than 10,000 tokens of the context from the cache, and the model context and the history keep the same messages

### Requirement: Repeated keep-alive requests
After a keep-alive request, the daemon MUST act again at 5/6 of the cache lifetime. The keep-alive requests MUST stop 6 hours after the last turn. `MEGACHAT_KEEPALIVE_HOURS` MAY replace this time.

Tests: `test/keepalive.test.mjs`

#### Scenario: The default idle time
- **WHEN** the cache lifetime is 1 hour and the conversation stays idle for 24 hours
- **THEN** keep-alive requests go out at 50, 100, 150, 200, 250, 300 and 350 minutes, and no more

#### Scenario: A shorter idle time
- **WHEN** `MEGACHAT_KEEPALIVE_HOURS` is `2` and the conversation stays idle for 24 hours
- **THEN** keep-alive requests go out at 50 and 100 minutes only, and a new turn starts them again

### Requirement: Cold cache and restart
The daemon MUST send no keep-alive request when the cache lifetime is over, and after a keep-alive request that failed. After a restart, the time of the last message of the model context MUST stand for the time of the last model request.

Tests: `test/keepalive.test.mjs`

#### Scenario: A computer that slept
- **WHEN** the computer sleeps for 2 hours after a turn with a 1-hour cache
- **THEN** the daemon sends no keep-alive request

#### Scenario: A failed keep-alive request
- **WHEN** the first keep-alive request fails
- **THEN** the daemon sends no more keep-alive requests

#### Scenario: A restart
- **WHEN** the daemon restarts, and the last message of the model context is 20 minutes old
- **THEN** a keep-alive request goes out 30 minutes after the restart, and a message of 61 minutes gets no request

### Requirement: Keep-alive off
`MEGACHAT_KEEPALIVE=0` MUST stop the keep-alive requests and the summary of an idle conversation. It MUST NOT change the cache lifetime.

Tests: `test/keepalive.test.mjs`

#### Scenario: The variable is 0
- **WHEN** `MEGACHAT_KEEPALIVE` is `0` and a large conversation stays idle for 24 hours
- **THEN** the daemon sends no keep-alive request and no summary request, and the turn asks for the cache retention `long`

### Requirement: Log of the idle requests
The log of the daemon MUST get one line with the token counts and the cost of each keep-alive request and of each summary request. The line MUST hold no content of the conversation.

Tests: `test/keepalive.test.mjs`

#### Scenario: The line of a keep-alive request
- **WHEN** a keep-alive request reads a context of 50,000 tokens
- **THEN** the log gets the line "A keep-alive request kept the prompt cache warm: context 50000, input 10, cache read 50000, cache write 0, output 1 tokens, cost 0.01 USD."

#### Scenario: The line of a summary request
- **WHEN** the idle daemon writes a summary
- **THEN** the log gets a line "A summary request:" with the input, cache read, cache write and output tokens and the cost in USD
