# Design

## Context

See proposal.md, "Why". The present code:

- `AcpRunService` reads the effective values of the directory of the run with `this.settings(run.cwd)` at each start of
  a session, and it builds `_meta.claudeCode.options` of `session/new` and `session/load` for a Claude child with
  `model`, `settingSources`, `promptSuggestions: false` and `allowDangerouslySkipPermissions: false`
  (`src/AcpRunService.mjs`, near the comment "A Claude child loads each settings source"). The options hold no
  `settings`, and a test checks that (`test/child-settings.test.mjs`, "a Claude child loads the settings of the user
  ...").
- The rules paragraph of the steps comes from `childRulesText()` in `src/PiMegachatService.mjs` at each dispatch.

How the Claude adapter 0.102.0 merges the options (`@agentclientprotocol/claude-agent-acp/dist/acp-agent.js`):

- It spreads `_meta.claudeCode.options` into the options of the SDK query (line 9276), and then it sets its own fields.
- `disallowedTools` is `[...options.disallowedTools, ...its own list]` (line 9318). Its own list is
  `["AskUserQuestion"]` for a client without form elicitation, which Megachat is. So the rules of Megachat stay.
- `settings` of the options is an object or a path to a JSON file (lines 9216-9219). The adapter adds `env` to it only
  when it routes the provider itself (`resolvedProvider`, from `providers/set` or a gateway auth request; Megachat sends
  neither) or with `CLAUDE_MODEL_CONFIG` (lines 9220-9230). It then sets `settings` after the spread (line 9281).
- A changed `disallowedTools` or `settings` on `session/load` rebuilds the query process (`OPTION_REBUILDS_SESSION`,
  line 404). Megachat starts a new adapter process for each run, so a follow-up gets the current rules.

The SDK 0.3.321 passes `disallowedTools` as `--disallowedTools` and `settings` as `--settings <JSON>`, the "flag
settings" layer (`@anthropic-ai/claude-agent-sdk/sdk.d.ts`, the option `settings`). Claude Code checks the deny rules,
then the ask rules, then the allow rules of each source. A request of an ask rule goes to the `canUseTool` of the
adapter, which sends `session/request_permission` to Megachat. The SDK documents `matched_ask_rule` for such a request
and tells a host to treat it as a request for a person.

The Codex adapter 2.6.0 (`@agentclientprotocol/codex-acp/dist/index.js`) builds `-c <key>=<value>` overrides only for
the provider of the gateway (`CodexConfigOverride.ts` in the bundle). It reads no command rule from `_meta`.

## Goals / Non-Goals

**Goals:**

- A push of a Claude child with `children.push` `ask` gives a permission request in the chat, also with an allow rule of
  the user. With `deny`, Claude Code refuses it. The same for a commit.
- No change of the defaults and of the prompt text.

**Non-Goals:**

- A full guard. A sandbox, a git hook in the repository, or a wrapper of `git` would change the repository or the
  environment of the user. The design does not do that.
- A guard for a Codex child.

## Decisions

### D1. `deny` goes to `disallowedTools`, `ask` goes to `settings.permissions.ask`

`disallowedTools` is a deny rule of the command line. A deny rule wins over each allow rule. It needs no session
settings.

`ask` needs an ask rule. The SDK has no option for an ask rule other than `settings`. So the options hold
`settings: { permissions: { ask: [...] } }`, and nothing else. This modifies the requirement "Key and base URL only in
the environment" of `claude-child`: the reason of that requirement is the key in the base URL, and an ask rule holds no
key. A test checks that `settings` has only `permissions.ask`, and that the options hold no `test-key` and no `wire`.

Alternatives:

- `ask` as a deny rule, with an approval flag of `agents_spawn` that removes the rule. The main agent sets the flag on
  its own word, as it writes "the user approved" in the task today. So the flag adds a schema field and no safety. A
  permission request asks the person.
- `ask` with no rule. Then the default `ask` stays without a guard, and the problem of issue #13 stays for each
  colleague with the defaults.
- A `PreToolUse` hook. A hook of the SDK is a function in the process of the adapter, and Megachat talks to the adapter
  through ACP. A hook command in the settings would need a file of Megachat in the settings of the user.

### D2. One map of the patterns

`src/Settings.mjs` gets `CHILD_STEP_RULES = { commit: "Bash(git commit:*)", push: "Bash(git push:*)" }`. A function
`claudeStepRules(values)` gives `{ disallowedTools, settings }` with only the parts that have a rule, in the order
commit, push. `AcpRunService` spreads the result into the options of a Claude child. `children.daemonRestart` gets no
pattern, because no one command stops the daemon.

### D3. The descriptions

`setting.children.commit` and `setting.children.push` of `resources/Megachat.properties` get one more sentence: "A
Claude child also gets a permission rule for a command that starts with git push. This is no full guard: a child can
still push in another way, such as git -C." The rules paragraph in the prompt stays as it is.

### D4. Disconnects and restarts

The rules come from the settings at each start of a session, so a continuation after a restart of the daemon gets the
rules of that time. A permission request of an ask rule is a request of the run, and the state keeps it through a
disconnect of the ACP client and a restart, as each other request. No state file changes.

## Risks / Trade-offs

- [The mode `auto` does not ask for an ask rule] → Task 1.1 checks it with the real adapter before the code. With no
  `permissions.defaultMode`, the adapter starts a child in the mode `auto` when the session offers it, so this case is
  common. The result goes into the spec before the code.
- [A user approved the push in the task, and now also gets a permission request] → That is one more click for a push,
  and only for `ask`. A user who wants no question sets `children.push` to `allow`.
- [A child pushes in another way] → The guard is a best effort, and the descriptions and `README.md` say so. The rules
  paragraph still forbids it.
- [The session settings are in the command line of the Claude process] → They hold only the patterns, no key and no
  path of the user.
- [A later adapter changes the merge of `disallowedTools` or `settings`] → The test checks the options that Megachat
  sends, and the live check of task 1.1 goes to `docs/manual-checks.md`. A new adapter version needs that check again.
- [The answer "Always allow" in the permission request adds a session allow rule] → An ask rule wins over an allow
  rule, so the next push asks again.

## Migration Plan

No migration. A rollback removes the rules and keeps the prompt text.
