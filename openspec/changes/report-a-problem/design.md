# Design

## Context

See `proposal.md`, part "Why". The main agent gets the bundled rules of `resources/instructions.md`, the rules of the
user, and the sections of the main extension of `src/PiMegachatService.mjs`: `settings` and `memory`. Pi Durable sends
a changed section as a later system message, so a change of a section keeps the prompt cache of the bundled rules and
of the conversation (`test/settings.test.mjs`, "Only the section of the settings goes again"). The daemon knows its
version (`megachatVersion` of `src/MegachatBuild.mjs`) and its state directory (`stateDirectory`, which `src/main.mjs`
passes to `PiMegachatService.open`). The main agent has no tool that reads a file.

## Goals / Non-Goals

**Goals:**

- The chat gives the version, the state directory, the path of `daemon.log` and the issue address.
- The chat tells the user to check the log for private text, and it never puts the log into a public place.

**Non-Goals:**

- A tool that reads or summarizes the log.
- A report that Megachat writes or sends.

## Decisions

### 1. A section `about`, not a part of the bundled rules

The facts go into a new section `about` of the main extension, after the section `settings`. A new version after an
update then sends only this section again. A version in `resources/instructions.md` would change the first system
message at each update, and the next request would write the whole conversation to the prompt cache again.

The section renders `instructions.about` and `instructions.report` of `resources/Megachat.properties`:

- `instructions.about`: "This is Megachat {0}. The state directory is {1}. The log of the daemon is {2}. Issues of
  Megachat go to {3}."
- `instructions.report`: the rules of the answer about a problem and of the log in a public place, in the words of the
  two requirements.

The arguments are the version, the state directory, `join(stateDirectory, 'daemon', 'daemon.log')` and the constant
`ISSUES_URL` = `https://github.com/ignatov/megachat/issues`. Without a state directory, for a test, the section has no
paths and says so. The values do not change while the daemon runs.

Alternative: the facts in the result of `agents_settings`. The agent then must know that it must call the tool, and
the walk shows that it did not. Left out.

### 2. No secret in the section

The section reads only the version and the state directory. It does not read `daemon/connection.json`, the
environment or the configuration of Central. So it cannot hold the token, the port or the base URL. A test checks the
text against the token and the port of a running daemon and against the base URL of the test configuration.

### 3. The private data rules are rules, not a filter

The main agent has no tool to read the log, and a child reads a file only for a task. So the rules tell the agent what
to say and what not to do. Megachat does not filter the reply. A child that the user asks to read the log locally is
not a public place, so the rules do not forbid it.

### The admitted work and the state

No state file and no field changes. A restart renders the section again from the version of the new daemon. No ACP
message and no `_meta` key changes.

## Risks / Trade-offs

- [The model does not follow the rule] → the live check 2.2 asks the question of the walk and records the answer.
- [The state directory holds the name of the user] → the path goes to the model through Central, as the paths of the
  projects do already. The rules tell the user to remove such text before a public report.
- [A daemon of an earlier release has no section] → the chat answers as today until the update.
