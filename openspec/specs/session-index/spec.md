# session-index Specification

## Purpose
With the consent of the user, Megachat keeps a local index of the past Claude Code, Codex and pi sessions in `sessions.sqlite`. The session tools answer from this index, and the index keeps no text that looks like a secret.

## Requirements

### Requirement: Setting of the index
With the setting `sessions.index` on, Megachat MUST keep an index of the past Claude Code, Codex and pi sessions in `sessions.sqlite` in the state directory. The default is off.

Tests: `test/session-index.test.mjs`

#### Scenario: The default value
- **WHEN** the user did not set `sessions.index`
- **THEN** the output of `agents_settings` with `get` gives the state `off` for the index

#### Scenario: The setting on
- **WHEN** the setting `sessions.index` is on, and a listed directory has one Claude Code session and one pi session
- **THEN** `sessions.sqlite` is in the state directory, and the output of `agents_settings` with `get` gives 2 sessions for the index

### Requirement: Consent of the user
The setup MUST ask for the consent with "Index past Claude, Codex and pi sessions in your projects, and read the logs of the agent sessions that run on this machine to show their status? Megachat reads the content of a session only when you ask. Everything stays local." The main agent MUST set `sessions.index` to on only when the user agrees.

Tests: `test/session-index.test.mjs`

#### Scenario: The question of the setup
- **WHEN** the setup asks the user about the index
- **THEN** the question is "Index past Claude, Codex and pi sessions in your projects, and read the logs of the agent sessions that run on this machine to show their status? Megachat reads the content of a session only when you ask. Everything stays local."

### Requirement: Index off
With the setting off, Megachat MUST read no session file for the index or for the live table of `agents_running`, watch no directory of a provider, and keep no `sessions.sqlite`. A change to off MUST stop the import and delete the file.

Tests: `test/session-index.test.mjs`

#### Scenario: A file of an earlier consent
- **WHEN** the setting `sessions.index` is off, and the state directory has a `sessions.sqlite` of an earlier consent
- **THEN** Megachat deletes `sessions.sqlite`, opens no session file and watches no directory

#### Scenario: A change to off
- **WHEN** the main agent sets `sessions.index` from on to off
- **THEN** Megachat deletes `sessions.sqlite` and closes each watch of a provider root

### Requirement: Start of the index
A change to on MUST start the import at once, without a restart. A start that failed, for example because the index file could not open, MUST run again at the next set of a setting of the index, also of the same value.

Tests: `test/session-index.test.mjs`

#### Scenario: A change to on
- **WHEN** the main agent sets `sessions.index` to on in a daemon that runs
- **THEN** the import reads the session files without a restart, and a search for a pi session gives a page from the index

#### Scenario: An index file that could not open
- **WHEN** the start failed because the directory of the index file did not exist, and the directory exists now
- **THEN** the next set of `sessions.index` to on starts the index, and the state of the index becomes `ready`

### Requirement: Sessions of the listed directories
The index MUST hold only a session whose `cwd` is a listed directory or a directory in one. The sessions of a newly listed directory MUST enter the index. The sessions of a removed directory MUST leave it.

Tests: `test/session-index.test.mjs`

#### Scenario: A directory in a listed directory
- **WHEN** `~/src/alpha` is the only listed directory, and Claude Code sessions have the `cwd` `~/src/alpha`, `~/src/alpha/sub`, `~/src/alpha-two` and `~/src/beta`
- **THEN** the index holds only the sessions of `~/src/alpha` and `~/src/alpha/sub`

#### Scenario: A newly listed directory and a removed directory
- **WHEN** the user adds `~/src/beta` to the projects, and later removes it
- **THEN** the old Claude Code and Codex sessions of `~/src/beta` enter the index, and after the removal they leave the index

### Requirement: Sources of the index
The sources MUST be `~/.claude/projects/<encoded cwd>/<session ID>.jsonl`, `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` or `$CODEX_HOME/sessions`, the archived Codex sessions `~/.codex/archived_sessions/rollout-*.jsonl` or `$CODEX_HOME/archived_sessions`, and `~/.pi/agent/sessions/--<path>--/*.jsonl` or `PI_CODING_AGENT_SESSION_DIR`.

Tests: `test/session-index.test.mjs`

#### Scenario: The default roots
- **WHEN** the home directory is `/home/user`, and no variable of a provider is set
- **THEN** the roots are `/home/user/.claude/projects`, `/home/user/.codex/sessions`, `/home/user/.codex/archived_sessions` and `/home/user/.pi/agent/sessions`

#### Scenario: The variables of the providers
- **WHEN** `CODEX_HOME` is `/cx` and `PI_CODING_AGENT_SESSION_DIR` is `/pi`
- **THEN** the roots of Codex and pi are `/cx/sessions`, `/cx/archived_sessions` and `/pi`

### Requirement: Compressed Codex files
Codex compresses a session file without a change for 7 days to `rollout-*.jsonl.zst`, in both Codex directories. The import MUST read such a file with the same rules as a plain file: the age limit by the modification time, the cut of each entry and the secret filter.

Tests: `test/session-index.test.mjs`

#### Scenario: A compressed archived file
- **WHEN** an archived `rollout-*.jsonl.zst` of 30 days ago has an entry of more than 3000 characters, and its last line, without a newline, has `password=hunter2hunter2`
- **THEN** the index keeps at most 2000 characters of the entry, the last line becomes `password=[secret removed]`, and a search for `hunter2` finds nothing

#### Scenario: A compressed file older than the age limit
- **WHEN** `sessions.days` is 180, and the modification time of a compressed archived file is 200 days ago
- **THEN** the session of the file does not enter the index

### Requirement: Import of a compressed file
A compressed file MUST have a new import of the whole file at each change. When the plain file and the compressed file of one session both exist, the import MUST take the plain file, as Codex does.

Tests: `test/session-index.test.mjs`

#### Scenario: A plain file and a compressed file of one session
- **WHEN** the session `both` has a plain file with "juniper both plain" and a compressed file with "juniper both stale"
- **THEN** the index holds the session `both`, and a search for `stale` finds nothing

### Requirement: Moves of a Codex file
When Codex compresses a file, makes a plain file of a compressed one again, or moves a file to the archive and back, the session MUST keep each entry, in each order of the watch events. A file that leaves the index MUST make a new import of each other file of its session from the start.

Tests: `test/session-index.test.mjs`

#### Scenario: A compression and an archive
- **WHEN** Codex writes the `.jsonl.zst` file next to the plain file and deletes the plain file, then the file moves to `archived_sessions`, and the watch tells the new path before the old path
- **THEN** after each step, the index holds each entry of the session

#### Scenario: A restore
- **WHEN** a plain file of the archived session comes back in `sessions`, and the compressed file leaves `archived_sessions`
- **THEN** the index holds each entry of the session, and it has one file of the session

### Requirement: Files that hold no running session
An archived file and a compressed file hold no running session: the live table of `agents_running` MUST NOT read them.

Tests: `test/session-index.test.mjs`

#### Scenario: Plain, compressed and archived Codex files
- **WHEN** the index holds a plain Codex file, a compressed Codex file and an archived Codex file
- **THEN** the live table of `agents_running` reads only the plain file

### Requirement: Age limit
The import MUST take the sessions with activity in the last `sessions.days` days, 180 by default. The value 0 MUST take all sessions. A session that becomes older MUST leave the index at the next pass.

Tests: `test/session-index.test.mjs`

#### Scenario: A session older than the limit
- **WHEN** `sessions.days` is 30, and two sessions have their last activity 40 days ago and 20 days ago
- **THEN** only the session of 20 days ago enters the index, and the import does not read the file of 40 days ago

#### Scenario: A session that becomes older
- **WHEN** 15 more days go by, and the next pass runs with `sessions.days` 30
- **THEN** the session, now 35 days old, leaves the index

#### Scenario: The value 0
- **WHEN** `sessions.days` changes to 0
- **THEN** both sessions are in the index

### Requirement: Appended lines
For each file, the index MUST keep the path, the size, the modification time, the inode, the byte offset of the import, and a hash of the 128 bytes before the offset. The import MUST read only the appended complete lines. A last line without a newline MUST stay unread until it is complete.

Tests: `test/session-index.test.mjs`

#### Scenario: A line that is not complete
- **WHEN** a session file has two complete lines and a last line "gamma question" without a newline
- **THEN** the index holds 2 entries, and a search for `gamma` finds nothing

#### Scenario: Appended lines
- **WHEN** a writer completes the line "gamma question" and adds the line "delta answer"
- **THEN** a search finds `gamma` and `delta`, and the index holds 4 entries

### Requirement: Rewritten files
A smaller file, another inode, or other bytes before the offset, as after a rewrite in place, MUST make the import read the whole file again.

Tests: `test/session-index.test.mjs`

#### Scenario: A truncation and a rotation
- **WHEN** a file becomes shorter than its imported part, or another file of the same size and with another inode takes its path
- **THEN** the import reads the whole file again, and the old entries leave the index

#### Scenario: A larger file after a rewrite in place
- **WHEN** a writer rewrites a file in place with three other lines, and the file becomes larger
- **THEN** the import reads the whole file again, and the index holds only the 3 new entries

### Requirement: Same size and another modification time
A file that the import read to its end, with the same size and another modification time, MUST make the import read the whole file again too, because a writer of a session file only adds lines. So a rewrite in place that changes only bytes before the last 128 is found without a read of each file at each pass. A `touch` gives a new import too. A rewrite that also makes the file larger and keeps the 128 bytes before the offset is not found.

Tests: `test/session-index.test.mjs`

#### Scenario: A change before the last 128 bytes
- **WHEN** a writer changes "kappa first" to "sigma first" more than 128 bytes before the end of the file, with the same size and another modification time
- **THEN** a search for `sigma` finds the session, and a search for `kappa` finds nothing

#### Scenario: A file without a change
- **WHEN** the size and the modification time of a file in the index stay the same
- **THEN** the next pass does not open the file

### Requirement: Copied entries
An entry with the entry ID of an entry in the index, such as a copy in a fork, MUST be in the index one time.

Tests: `test/session-index.test.mjs`

#### Scenario: A fork
- **WHEN** the session `fork` copies the two entries of the session `original` and adds one entry
- **THEN** the index holds 3 entries, and a search for `juniper` gives one match

### Requirement: Size of an entry
The index MUST keep at most about 2 KB of the text of each entry, tool calls and tool results included.

Tests: `test/session-index.test.mjs`

#### Scenario: A long tool result
- **WHEN** a tool result has more than 5000 characters, and the last word is `tailmarker`
- **THEN** the index keeps at most 2000 characters of the result, and a search for `tailmarker` finds nothing

### Requirement: Secret filter
Before the index keeps a text, it MUST replace each text that looks like a secret with a marker: an API key with a well-known prefix, a Bearer token, a private key block, a JWT, and an assignment such as `password=` with a long value, also in a JSON text with escaped quotes such as the arguments of a tool call. This is a best effort: a secret of another shape can stay in the index.

Tests: `test/session-index.test.mjs`

#### Scenario: Secrets in a tool result
- **WHEN** a tool result has `sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345`, `ghp_abcdefghijklmnopqrstuvwxyz0123456789`, `AKIAIOSFODNN7EXAMPLE`, a Bearer JWT, `password=hunter2hunter2` and an OpenSSH private key block
- **THEN** the index keeps `[secret removed]` in place of each secret, the name `password=` stays, and a search for `hunter2` finds nothing

#### Scenario: An assignment in a tool call
- **WHEN** the arguments of a `Write` tool call have the content `{"password": "hunter2hunter2", "api_key": "Zq9vX2mL7pR4tY8w"}`
- **THEN** the index keeps `\"password\": \"[secret removed]`, and it keeps neither value

### Requirement: Key after /wire/ in a URL
The filter MUST replace the path segment after `/wire/` in a URL with a scheme, whatever its shape, because the base URL of JetBrains Central holds the key there: `http://127.0.0.1:<port>/wire/<key>`. The rest of the URL MUST stay. A path such as `src/wire/Codec.kt` without a scheme, and a URL that ends with `/wire/` or that has no segment `wire`, MUST stay. A text that the filter changed already MUST stay as it is.

Tests: `test/session-index.test.mjs`

#### Scenario: A base URL with a key
- **WHEN** the text is `https://gateway.example.test/api/wire/Qm7Tz2Lw9Xc4Vb8Nk1Rj6Hs3Fd5Gp0Ya2Ue/anthropic/v1/messages`
- **THEN** the filter gives `https://gateway.example.test/api/wire/[secret removed]/anthropic/v1/messages`, and the filter gives this result again without a change

#### Scenario: Texts with wire that stay
- **WHEN** the texts are `see src/wire/Codec.kt`, `https://github.com/google/wire`, `http://127.0.0.1:9/wire/` and `https://example.test/wireless/abc`
- **THEN** the filter gives each text without a change

#### Scenario: An index file of the version before the filter of /wire/
- **WHEN** an index file of the version 3 holds the text `juniper http://127.0.0.1:9/wire/Qm7Tz2Lw9Xc4Vb8Nk1Rj6Hs3Fd5Gp0Ya2Ue/v1`
- **THEN** the next start makes the index again, and the entry is `juniper http://127.0.0.1:9/wire/[secret removed]/v1`

### Requirement: Passwords in URLs, Basic authentication and quotes
The filter MUST also replace the password in the user information of a URL (`https://user:password@host`), the text after `Basic` that is the base64 text of `user:password`, the password of the option `-u` or `--user` of `curl`, and the whole value in quotes of such an assignment, so a passphrase with spaces goes as a whole.

Tests: `test/session-index.test.mjs`

#### Scenario: A URL, Basic authentication and a passphrase
- **WHEN** the texts are `git clone https://alice:Tr0ub4dor3@git.example.com/team/repo.git`, `Authorization: Basic YWxpY2U6czNjcjN0` and `PASSPHRASE="correct horse battery staple"`
- **THEN** the filter gives `git clone https://alice:[secret removed]@git.example.com/team/repo.git`, `Authorization: Basic [secret removed]` and `PASSPHRASE="[secret removed]"`

#### Scenario: The option of curl
- **WHEN** the text is `curl -u alice:Tr0ub4dor3 https://api.example.com`
- **THEN** the filter gives `curl -u alice:[secret removed] https://api.example.com`

### Requirement: Text around a secret
The text around a secret MUST stay: the name, the quotes, the user and the host. An email address, an `ssh` remote such as `git@github.com:owner/repo.git`, a URL with a user and no password, a word after `Basic` such as `Basic usage`, and a sentence with the word `password` and no value in quotes MUST stay as they are.

Tests: `test/session-index.test.mjs`

#### Scenario: A passphrase in quotes
- **WHEN** the text is `passphrase: 'correct horse battery staple'`
- **THEN** the filter gives `passphrase: '[secret removed]'`, with the name and the quotes

#### Scenario: Texts that stay
- **WHEN** the texts are `git remote add origin git@github.com:owner/repo.git`, `Basic usage of the tool is simple, and basic auth works.` and `Reset the password of the user, then sign in again.`
- **THEN** the filter gives each text without a change

### Requirement: Version of the filter
A change of the filter MUST change the index `VERSION`, so the next start makes the index again from the session files, and no text that an earlier filter kept stays.

Tests: `test/session-index.test.mjs`

#### Scenario: An index file of an earlier filter
- **WHEN** an index file of the version 2 holds the text `juniper https://alice:Tr0ub4dor3@git.example.com/repo`
- **THEN** the next start makes the index again, and the entry is `juniper https://alice:[secret removed]@git.example.com/repo`

### Requirement: Titles of sessions
Each title of a session, from the session file or from the first prompt, MUST go through the same filter, and the index MUST keep at most 200 characters of it.

Tests: `test/session-index.test.mjs`

#### Scenario: A title with a secret
- **WHEN** a Claude Code session has a custom title that starts with "Deploy with" and an API key, and has more than 5000 characters
- **THEN** the title in the index starts with "Deploy with [secret removed]" and has at most 200 characters

### Requirement: Order of the first pass
The first pass MUST import the files of the projects of an IDE first, and the newest files first. The import MUST run in bounded batches with a pause between them, so the chat stays usable.

Tests: `test/session-index.test.mjs`

#### Scenario: A project of an IDE and another listed directory
- **WHEN** a project of an IDE has sessions of 2 days ago and of 5 days ago, and another listed directory has a session of 1 day ago
- **THEN** the first pass imports the session of 2 days ago, then the session of 5 days ago, then the session of the other directory

### Requirement: Unreadable files
A file that the import cannot read MUST NOT stop a pass. The import MUST log the failure without a path or a text, skip the file, and continue with the other files. A pass that failed MUST run again on the next change of a session file.

Tests: `test/session-index.test.mjs`

#### Scenario: One file that cannot open
- **WHEN** one of three session files of a project cannot open
- **THEN** the pass ends, the state of the index is `ready`, and the index holds the other two sessions

#### Scenario: A pass that failed
- **WHEN** the first pass fails because the state cannot be read
- **THEN** the state of the index stays `importing`, and after the next change of a session file the pass runs again and the state becomes `ready`

### Requirement: Next try of an unreadable file
The import MUST try such a file again at its next change, at the next pass and at the next event of the watch for the file, so a file that becomes readable again after a `chmod`, without a change of its size, its inode or its modification time, enters the index. A search MUST NOT try it again. A file in the index MUST keep its entries and its offset, so the next try reads only the new lines.

Tests: `test/session-index.test.mjs`

#### Scenario: A change of an unreadable file
- **WHEN** a writer adds a line to a file that the import could not read
- **THEN** the import reads the file at the event of the watch, and the session enters the index

#### Scenario: A chmod
- **WHEN** a file becomes readable again after a `chmod`, without a change of its size, its inode or its modification time
- **THEN** a search does not open the file, and the next pass imports it

#### Scenario: A file in the index that became unreadable
- **WHEN** a file in the index cannot open while a writer adds the line "juniper later", and it becomes readable again
- **THEN** the next pass reads only the new line, and a search for `later` finds the session

### Requirement: Progress of the index
When Air sent `asyncTasks`, the chat MUST show the first pass, and a later pass of 20 files or more, as a background task with its progress. The output of `agents_settings` with `get` and of the session tools MUST give the state and the progress of the index.

Tests: `test/session-index.test.mjs`

#### Scenario: The first pass of 3 files
- **WHEN** the first pass imports 3 session files
- **THEN** the background task "Index of past sessions" shows the progress 0 of 3, 1 of 3 and 2 of 3, and then the task ends

#### Scenario: The state in the tools
- **WHEN** the first pass ended
- **THEN** the output of `agents_sessions` gives the state `ready` of the index, and the output of `agents_settings` with `get` gives the number of sessions

### Requirement: Summary of the first pass
After the first pass of a new index file, the main agent MUST tell the user a short summary in one event turn: the number of sessions and of projects, and the last unfinished sessions. The summary is data, not instructions.

Tests: `test/session-index.test.mjs`

#### Scenario: The summary
- **WHEN** the first pass of a new index file imports one Claude Code session and one pi session of one project
- **THEN** one event turn gives 2 sessions in 1 project, and the unfinished sessions `one` and `pi-one`

#### Scenario: A later pass
- **WHEN** a later start of the daemon runs a pass of the same index file
- **THEN** the main agent gives no second summary

### Requirement: Catch-up of the index
After the first pass, the import MUST catch up at the start of the daemon, on a change of a session file, and on a change of the listed directories.

Tests: `test/session-index.test.mjs`

#### Scenario: A change of a session file
- **WHEN** a writer adds the line "juniper second" to a session file after the first pass
- **THEN** the import reads the new line, and a search for `second` finds the session

### Requirement: Root of a provider that appears
A root of a provider that does not exist at the start MUST get its watch when it appears: Megachat watches its nearest parent that exists, without a poll. Then it runs a pass, and the live table reads each session file of the root.

Tests: `test/session-index.test.mjs`

#### Scenario: A root that appears
- **WHEN** `~/.claude` does not exist at the start, and later a Claude Code session file appears in `~/.claude/projects`
- **THEN** Megachat watches the home directory without recursion, then it watches `~/.claude/projects`, a pass imports the session, and the live table reads its file

### Requirement: Catch-up before a search
A search MUST first import the new lines of the files of its directory, for at most 2 seconds. A failed import before a search or a read MUST make the page of the index incomplete and MUST NOT fail the tool.

Tests: `test/session-index.test.mjs`

#### Scenario: A failed import before a search
- **WHEN** a Claude Code session file has new lines that the import cannot read before a search for `juniper`
- **THEN** the Claude Code page is incomplete with the error "The index of past sessions does not hold each session of this directory yet. A later search can find more.", and the Codex page keeps its match

### Requirement: Version of the index file
An index file of another `VERSION` MUST be made again from the session files. The live table of `agents_running` in the same file MUST be made again too, so each table of the file has the same version.

Tests: `test/session-index.test.mjs`

#### Scenario: An index file of the version 0
- **WHEN** an index file of the version 0 holds an entry that no session file has
- **THEN** the next start makes the index again, and the index holds only the entry of the session file

#### Scenario: An index file of the version 1
- **WHEN** an index file of the version 1 has a row of the live table for a file that does not exist
- **THEN** the next start makes both tables again, and the live table has only the row of the session file that exists

### Requirement: Answers from the index
With the index on, `agents_sessions` and `agents_session_history` of the main agent, and the tools `sessions` and `session_history` of a child, MUST answer from the index. A search MUST give one match for each session, best bm25 first, with a snippet.

Tests: `test/session-index.test.mjs`

#### Scenario: One match for each session
- **WHEN** the index holds the Claude Code session `indexed` with 25 entries that have the word "juniper"
- **THEN** a search for `juniper` gives one match for `indexed` from the index, with a text that has "juniper", and Megachat does not call the live provider of Claude Code

#### Scenario: A read from the index
- **WHEN** the caller reads the session `indexed` of 25 entries
- **THEN** the first page has 20 entries from the index, and the page of its cursor has the last 5 entries

### Requirement: Pages of the index
A later page of a search or of a list MUST NOT give a session of an earlier page again. A later page of a search MUST skip each entry that came after its first page. A list MUST page by the time of the last activity and the row ID of a session, not by a count.

Tests: `test/session-index.test.mjs`

#### Scenario: More sessions than one page holds
- **WHEN** 23 sessions match `juniper`, and the caller follows each cursor
- **THEN** the pages give each of the 23 sessions one time

#### Scenario: New entries between two pages
- **WHEN** a session of the first page and a new session get entries with the query between the first page and the second page
- **THEN** the second page gives each other session of the first search, and it gives no session of the first page again

### Requirement: Live provider and pi
The tools `agents_sessions` and `agents_session_history` of the main agent, and the tools `sessions` and `session_history` of a child, MUST use the live provider when the index is off, when the index has no session of the agent in the directory, and for a query without a word of 3 or more characters.

pi MUST be an agent of these tools. Without the index, a request for pi MUST fail with a text that says that the index is off.

Tests: `test/session-index.test.mjs`

#### Scenario: No session of the agent in the index
- **WHEN** the index holds no Codex session of the directory
- **THEN** a search for `juniper` gives the Codex page from the live provider

#### Scenario: A short query
- **WHEN** the query is `ju`
- **THEN** the page comes from the live provider

#### Scenario: pi without the index
- **WHEN** the index is off, and a child calls `sessions` with the agent `pi`
- **THEN** the tool fails with "The index of past sessions is off, so Megachat cannot read pi sessions. Only the user can turn it on, with the setting sessions.index."

### Requirement: Filter of the live answers
Each text and each title that the tools `agents_sessions` and `agents_session_history` of the main agent, and the tools `sessions` and `session_history` of a child, give from a live provider or from the transcript of a pi child MUST go through `redactOwnSecrets`, with the exact values that the daemon knows, as a text of a child does (see the capability `secrets`). No other pattern of the filter applies there.

Tests: `test/session-history.test.mjs`

#### Scenario: A key in a session of a live provider
- **WHEN** the index is off, the daemon knows the key `Qm7Tz2Lw9Xc4Vb8Nk1Rj6Hs3Fd5Gp0Ya2Ue`, and the title and a message of a Claude Code session have this key
- **THEN** a read and a search for `Juniper` give the title and the text with `[secret removed]` in place of the key

#### Scenario: A key after /wire/ in a live answer
- **WHEN** a message of the session has `http://127.0.0.1:9/wire/Pk3Wq8Zr1Xn6Cm9Vt4Bs7Lh2Jd5Fg0Ka8Ty/v1`, and the daemon does not know this key
- **THEN** the read gives `http://127.0.0.1:9/wire/[secret removed]/v1`
