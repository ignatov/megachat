# Design

## The main point: the users of an earlier build

The setup rule "Do not store a value that is already the current value" has a consequence. A user of v0.6.3 or older
who answered off in the setup has no stored `sessions.index`. A user who skipped the setup has none either. With only a
new default, both users get the index after the update without their consent.

The store must tell three files apart:

| File | Onboarding | Stored `sessions.index` | Meaning | Value |
|---|---|---|---|---|
| none | (`pending`) | none | a first start | `on` |
| of an earlier build | `done` or `skipped` | none | an answer off, or a skip | `off` |
| of this build | `done` or `skipped` | none | the setup kept the default on | `on` |
| any | any | `on` or `off` | an answer | the stored value |

The second and the third row look the same without a marker. So the file gets a marker.

### Options

1. **Only a new default.** It turns the index on for a user who said off. Refused.
2. **Missing value is off after the setup, without a marker.** It breaks the third row: a setup of this build that
   keeps the default stores nothing, and the next start gives off. Refused.
3. **The setup always stores the answer of question 2.** A skip of the setup or of the question still stores nothing,
   and the next start gives off. A reset of the setting gives off after a restart. Refused.
4. **A marker, and a write at the open.** The open of a file without the marker stores `sessions.index` `off` (after
   the setup) and the marker. It conflicts with the requirement of the capability `suggestions` "the open MUST NOT
   change the file" for a file of v0.3.0, and the open gets a new failure path for a file that the daemon cannot write.
5. **A marker, a read rule, and a store at the first write.** Picked.

### The pick: option 5

- The new top-level key `defaults` of `settings.json` holds the version of the defaults, `2` (`DEFAULTS` in
  `src/Settings.mjs`). A file without the key is of v0.6.3 or older. The schema stays 1, so an earlier build still
  reads the file, and its write keeps the key.
- `SettingsStore.defaultOf(key)` gives `off` for `sessions.index` in a file without `defaults` and with the onboarding
  `done` or `skipped`. `MegachatSettings.entry` takes it in place of the default, also in its field `default`. So
  `agents_settings get` says `off` with the source `default` and the default `off` for such a file.
- The open does not change the file. The rule of the capability `suggestions` stays as it is.
- `SettingsStore.change` stores the earlier default before the operation, when the file has no `defaults` and the
  onboarding is `done` or `skipped` and no value is stored. Then it adds `defaults` 2. The first write of each kind
  (a `set`, a `reset`, the status of the onboarding, a project value) keeps the value.
- A file without `defaults` and with the onboarding `pending` is a user before the setup. It takes the defaults of this
  build, and its first write adds only `defaults` 2.
- A new file gets `defaults` 2 at its first write, from `emptySettings`.
- A file that the daemon cannot read moves aside, as before. The file can hold an answer off, so the new data gets
  `sessions.index` `off`, and the open writes the new file at once. Without that write, the next start finds no file
  and gives `on`. The open already renames the file in this case, so the write adds no new kind of change.

### A downgrade

An earlier build reads the file of this build: the schema is 1, and `invalidReason` does not check other top-level
keys. It keeps `defaults` in its writes. A file of this build without a stored value gives that build `off`, its
earlier default, so a downgrade turns the index off, and that build deletes `sessions.sqlite`. An upgrade again finds
`defaults` 2 and gives `on`. No answer of the user is lost.

## Decisions on the open questions

1. **Does a reset of `sessions.index` give on?** Yes. A reset takes the default of this build, also in a file of an
   earlier build, because the first write stores off and the reset then removes it. The main agent resets a setting
   only on a request of the user, and the result of the tool says the new value.
2. **Does the import wait for the setup?** No. The default on means that the import runs from the first start. The
   question 2 then tells the real state, and the answer off deletes the index at once (see the requirement "Index off"
   of the capability `session-index`). The setup rules already forbid an offer of the setup in the summary of the past
   sessions.
3. **Does a first start get a summary turn?** Only when the first pass found a session. A pass without a session starts
   no event turn, so a machine without agent sessions gets no unprompted model request. A later new project does not
   bring a summary, as before.
4. **An environment variable for `sessions.index`?** No. The setting had none. A test daemon reads the session
   directories of `test/state-guard.mjs`, which are empty. The live smoke run stores off in each home.
5. **What does the likely answer of the setup give?** In the mode `ghost`, it keeps the current value: "Keep the index
   on" for a new user, off for a user of an earlier build who runs the setup again. The rule "Do not give an answer
   that turns on a setting that the setup turns on only when the user agrees" stays.
6. **The offer of `sessions.notes`.** It is open only while `sessions.index` is on. With the default on, a new user
   gets the offer after the setup. The offer still asks the user, and `sessions.notes` keeps the default `off`.

## The side effects of on by default

- **The cost of the import.** `node test/bench/session-index.bench.mjs 20000` on this machine: 100 sessions with
  20,000 synthetic messages (90 MB of session files) took 30.4 s, gave an index file of 130 MB, and blocked the event
  loop at most 224 ms (p99 15 ms). The import takes only the sessions of the listed directories of the last 180 days,
  and at most about 2 KB of each message. The live table reads the head and the last 64 KB of each session file of the
  machine. The README states the size measurement of 640 MB for 100,000 messages.
- **The time of the start.** `SessionIndexService.apply` runs in `resume`, at the start of the daemon, so the first pass
  starts before the setup. It runs in bounded batches with a pause between them, so the chat stays usable.
- **The summary turn** after the first pass costs one model request, and only when the pass found a session.
- **Tests.** Each test that starts `src/main.mjs` has a temporary state directory, but the real `HOME`. Without the
  guard, its daemon reads `~/.codex/sessions` and `~/.pi/agent/sessions` of the user. `test/state-guard.mjs` sets
  `CODEX_HOME` and `PI_CODING_AGENT_SESSION_DIR` to empty temporary directories.

## State and messages

- `settings.json`: the new top-level key `defaults` (the number 2). The daemon reads it at the open and writes it at
  each write. A file of v0.6.3 or older gets it at its first write. The stored value `sessions.index` `off` of such a
  file comes at the same write.
- `sessions.sqlite`: no change. The meta column `announce` stays. A pass without a session clears it, as a pass with a
  summary does.
- No ACP message and no `_meta` key changes. The daemon keeps the admitted work through a disconnect and a restart as
  before: the change adds no admitted work.
