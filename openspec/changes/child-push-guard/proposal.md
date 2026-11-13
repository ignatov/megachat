# Proposal

## Why

The settings `children.commit` and `children.push` are only text in the prompt of a child (issue #13). Since
children-read-agent-settings (9c45540), a Claude child loads the settings of the user, with the allow rules of the
user and the permission mode. So when the user allows `git push` in `~/.claude/settings.json`, or the child runs in the
mode `auto`, a child can push with no question, against the default `children.push` `ask`. Colleagues use Megachat since
today, and a push to a shared remote cannot be undone easily.

## What Changes

Where it shows: the chat, as a permission request of the child, and the result of the child.

- **A guard for a Claude child through its permission rules.** At each start of a Claude session (a new task, a
  follow-up, a continuation), Megachat gives the adapter rules from the values of `children.commit` and
  `children.push`:
  - `deny` adds `Bash(git push:*)` (or `Bash(git commit:*)`) to `disallowedTools`. Claude Code refuses such a command,
    also when an allow rule of the user allows it. The child then says in its result that the step is necessary.
  - `ask` adds the same pattern to the ask rules (`permissions.ask` of the session settings). Claude Code then asks the
    user in a permission request before such a command, also when an allow rule of the user allows it. The request
    shows in the chat as each other request of a child.
  - `allow` adds no rule, as today.
- **The defaults stay.** `children.commit` stays `allow` and `children.push` stays `ask`. With the defaults, a push of a
  Claude child now gives a permission request in the chat. A commit gives none.
- **The prompt text stays.** The rules paragraph in the prompt of the child does not change. The permission rule is a
  second guard.
- **A best effort.** The rule matches only a command that starts with `git push` or `git commit`, also in a compound
  command. A child can still push or commit in another way: `git -C <dir> push`, `git -c <key>=<value> push`, a git
  alias, a script, a hook, `git merge` or `git rebase`, which make commits, another tool such as `gh`, or an MCP server of
  the user. The rules paragraph still forbids these. The setting descriptions and `README.md` say it.
- **No guard for a Codex child and a pi child.** A pi child runs no command. A Codex child gets the prompt text only,
  as today. The Codex adapter 2.6.0 takes no command rule from the client. Its `-c` overrides are only for the provider
  of the gateway. Codex reads its rules from its own home directory, which Megachat does not write
  (children-read-agent-settings: a Codex child reads its own `~/.codex`).

Decision for the author: the first task is a live check of the rules with the real adapter. If Claude Code does not ask
for an ask rule in the mode `auto`, the spec gets that result before the code, and the author decides whether `ask` in
the mode `auto` stays a prompt rule only.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `child-settings`: "Meaning of the step values" is modified, because `ask` and `deny` now have a permission rule for a
  Claude child. New requirements give the rules, their sources and the limits of the guard.
- `claude-child`: "Key and base URL only in the environment" is modified, because the options of a Claude child now
  hold session settings with only the ask rules.

## ACP and Air

No ACP extension changes. The rules go in `_meta.claudeCode.options` of `session/new` and `session/load`, which the
Claude adapter already reads. A permission request of an ask rule is a standard `session/request_permission`, which
Megachat already shows in the chat. Air needs no change.

## Impact

- Code: `src/AcpRunService.mjs` (the options of a Claude child), `src/Settings.mjs` (one map of the patterns, and the
  descriptions of `children.commit` and `children.push`), `resources/Megachat.properties` (the descriptions).
- Tests: cases in `test/child-settings.test.mjs`. A live check with a real Claude child and a local bare repository
  goes to `docs/manual-checks.md`.
- Documents: `README.md` (the settings of the children).
- The state: no change. The rules come from the effective settings at each start of a session.
- Out of scope:
  - A guard for a Codex child.
  - A guard for `children.daemonRestart`.
  - A full guard against each way to push or commit, such as a sandbox or a git hook.
  - A change of the defaults, of the rules paragraph, or of the permission mode.
  - No non-goal changes.
