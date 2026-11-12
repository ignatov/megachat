## MODIFIED Requirements

### Requirement: One filter of the own secret of Megachat
So the output of a run, `agents_inspect`, `agents_wait`, the result report, the conversation storage and its search index get the filtered text. One function, `redactOwnSecrets` of `src/SessionText.mjs`, MUST make this choice. The other patterns of the secret filter MUST NOT apply to this text: they can change data that the main agent needs, and the child sent the text to its provider already. The reason in the error of a failed run is an exception.

Tests: `test/child-secrets.test.mjs`

#### Scenario: A Claude child that prints its environment
- **WHEN** a Claude child prints its environment with the key and the base URL of Central
- **THEN** the output of the run, the result of `agents_inspect`, the conversation storage and each request to the provider hold no key

#### Scenario: Known values and a key after /wire/
- **WHEN** a text of a child holds the known key, the known base URL, and `http://127.0.0.1:9/wire/Pk3Wq8Zr1Xn6Cm9Vt4Bs7Lh2Jd5Fg0Ka8Ty/v1`
- **THEN** each of the three secrets becomes `[secret removed]`

#### Scenario: Other secrets of the child
- **WHEN** a text of a child holds `sk-abcdefghijklmnopqrstuvwxyz`, `password=hunter2hunter2`, `https://user:pa55word@example.com/repo` and a Bearer token
- **THEN** the text stays as it is

## ADDED Requirements

### Requirement: Filter of the error output of a child
Before the log or the error of a run gets a text of the error output or of an answer of an agent, the secret filter of the session index MUST apply to it, with the exact values that the daemon knows. The filter MUST run on the whole kept text and not on each chunk, so a secret in two chunks goes as a whole. Each cut of the text MUST come after the filter. This text never went to a provider, so the other patterns apply too.

Tests: `test/child-secrets.test.mjs`

#### Scenario: A key in two chunks
- **WHEN** the agent writes `key=` and the first 10 characters of the known key `Qm7Tz2Lw9Xc4Vb8Nk1Rj6Hs3Fd5Gp0Ya2Ue` in one chunk, then the rest of the key, the known base URL and `sk-abcdefghijklmnopqrstuvwxyz` in a second chunk, and exits with the code 3
- **THEN** the log and the error of the run hold `[secret removed]` in the place of each of the three secrets, and neither part of the key

#### Scenario: An answer with the base URL
- **WHEN** the agent answers `session/new` with the error -32603 and the `details` `Request to http://127.0.0.1:41234/wire/Qm7Tz2Lw9Xc4Vb8Nk1Rj6Hs3Fd5Gp0Ya2Ue/v1 failed` in its data
- **THEN** the log entry and the error of the run hold `Request to [secret removed]/v1 failed`

### Requirement: Cut start and open end of the error output
When the daemon dropped the start of the error output, the kept text MUST start after its first white space, so no second half of a secret stays. When the error output did not end in the wait, the text after the last white space and the longest end that is the start of a known value MUST go, because the next chunk can complete a secret.

Tests: `test/child-secrets.test.mjs`

#### Scenario: A cut in a key
- **WHEN** the start of the kept error output falls in the known key
- **THEN** the filtered text holds no part of the key, and it starts after the first white space

#### Scenario: The start of a key at the end
- **WHEN** the error output did not end in the wait, and its last line is `the key=` with the first 10 characters of the known key
- **THEN** the filtered text ends with `the ` and holds no part of the key
