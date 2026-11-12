# secrets Specification

## Purpose
Megachat removes its own secret, the key and the base URL of Central, from the texts of a child. So a transcript, the state, the main agent and the session index do not get this secret.

## Requirements

### Requirement: Exact values in the filter of a transcript
The filter of a transcript MUST also remove each exact value that the daemon knows at run time, also when no pattern matches its shape: the key and the base URL of each Central configuration that the daemon read, for the main agent and for a Claude child, and the path segment after `/wire/` of that URL. The address goes as a whole. (See the capability `transcripts`.)

Tests: `test/transcript.test.mjs`, `test/launch.test.mjs`, `test/session-index.test.mjs`

#### Scenario: A key and an address without a pattern
- **WHEN** the daemon knows the key `Qm7Tz2Lw9Xc4Vb8Nk1Rj6Hs3Fd5Gp0Ya2Ue` and the address `http://127.0.0.1:41234/proxy/Qm7Tz2Lw9Xc4Vb8Nk1Rj6Hs3Fd5Gp0Ya2Ue`, and a child writes them in its transcript
- **THEN** the transcript holds `[secret removed]` in the place of each value, and it does not hold `proxy/`

#### Scenario: A key after /wire/ that the daemon does not know
- **WHEN** a tool call of a child has the title `curl http://127.0.0.1:9/wire/Pk3Wq8Zr1Xn6Cm9Vt4Bs7Lh2Jd5Fg0Ka8Ty/v1/models`
- **THEN** the transcript holds `curl http://127.0.0.1:9/wire/[secret removed]/v1/models`

### Requirement: Exact values in the memory of the daemon
The values MUST stay in the memory of the daemon only: in no file, log, error message or command line. Each read of a configuration MUST add its values, and the newest 32 values MUST stay, so a key that changes while the daemon runs keeps its earlier value. A value shorter than 8 characters MUST be ignored.

Tests: `test/launch.test.mjs`, `test/session-index.test.mjs`

#### Scenario: A key that changes
- **WHEN** the daemon reads a Central configuration with a key, then reads it again after the key changed, and then reads the configuration of the main agent
- **THEN** the filter removes the two keys, the key of the main agent and the base URL, and an inspection or a JSON text of the configuration holds no key

#### Scenario: The newest 32 values
- **WHEN** the daemon knows 40 values
- **THEN** the filter removes the newest 32 values, and it keeps the oldest value

#### Scenario: A short value
- **WHEN** the daemon knows the value `short`
- **THEN** the text `a short text` stays as it is

### Requirement: Exact values in the import of the session index
The import of the session index MUST use the same values for each text and title. An import before the first read of a configuration has only the patterns.

The capability `session-index` gives the other rules of its secret filter.

Tests: `test/session-index.test.mjs`

#### Scenario: A session with the address of Central
- **WHEN** a Claude session has the title `Check <key>` and the message `juniper the base is <address> now`, and the daemon knows the key and the address
- **THEN** the index, the live table of `agents_running` and the read from the end of the log give the title `Check [secret removed]` and the text `juniper the base is [secret removed] now`

### Requirement: Own secret of Megachat in a text of a child
Before the state keeps a text of a child, Megachat MUST remove the own secret of Megachat from it: each exact value that the daemon knows, and the path segment after `/wire/` of a URL. This applies to each text chunk of a Claude or Codex child, to each answer of a pi child, to each text of the tool call of a permission request (its title and its raw input, not its ID and not the options, so the dialog and the answer work), and to the error text of a run.

Tests: `test/child-secrets.test.mjs`

#### Scenario: A permission request with the base URL
- **WHEN** a Claude child asks for a permission to run `curl` with the base URL of Central in the title and in the raw input
- **THEN** the permission request has the title `curl [secret removed]/v1/models`, and it keeps the tool call ID `curl` and the options `yes` and `no`

#### Scenario: A pi child and the error text of a run
- **WHEN** a pi child answers with the base URL and the key, and another run fails with the error `The child stopped at <base URL>/v1`
- **THEN** the output of the pi run holds `[secret removed]` two times, and the error is `The child stopped at [secret removed]/v1`

### Requirement: One filter of the own secret of Megachat
So the output of a run, `agents_inspect`, `agents_wait`, the result report, the conversation storage and its search index get the filtered text. One function, `redactOwnSecrets` of `src/SessionText.mjs`, MUST make this choice. The other patterns of the secret filter MUST NOT apply to this text: they can change data that the main agent needs, and the child sent the text to its provider already.

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

### Requirement: Secret in two chunks
A secret can come in two chunks. A filter of each chunk alone, or of the kept output again after each chunk, keeps the second part of the secret. So the state MUST hold back in the memory the end of the text that the next chunk can still make a secret: the text after the last white space, and the longest end that is the start of a known value, at most 16,000 characters.

Tests: `test/child-secrets.test.mjs`, `test/state.test.mjs`

#### Scenario: A key in two chunks
- **WHEN** a child sends `The key is `, then the first 10 characters of the known key, and then the rest of the key with ` and more`
- **THEN** the state keeps `The key is ` at once, nothing of the second chunk, and `[secret removed] and ` after the third chunk

#### Scenario: Chunks that end with a white space
- **WHEN** a child sends eight chunks, and each chunk ends with a line break
- **THEN** the output of the run holds the full text of the last chunks, and nothing waits

#### Scenario: The limit of the held text
- **WHEN** a chunk of 16,010 characters has no white space
- **THEN** the state keeps the first 10 characters at once, and 16,000 characters wait

### Requirement: Text that waits at the end of a run
The text that the state keeps MUST be the text that a filter of the whole text gives. The end of the run MUST add the text that waits. While the run works, the output lacks only this end. A kill of the daemon loses it. An answer of a pi child is a complete message, so nothing of it waits.

A text that an earlier build stored stays as it is.

Tests: `test/child-secrets.test.mjs`

#### Scenario: Each cut of a text
- **WHEN** a text with the known key, the known base URL and a key after `/wire/` arrives in two or three chunks, cut at each place
- **THEN** the kept text is the text that a filter of the whole text gives

#### Scenario: The end of a run
- **WHEN** a Claude child prints `The end` as the last text, and the run ends
- **THEN** the output of the run ends with `The ` while the run works, and it ends with `The end` after the end of the run
