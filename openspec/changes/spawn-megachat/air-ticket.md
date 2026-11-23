# Draft of an Air ticket (not filed)

Title: "Spawn Megachat" for the IDE and for one project, and "Remove Megachat"

Megachat (an ACP agent, the entry `Megachat` of `acp.json`) gets a project scope: one Megachat for one project
directory, with its own daemon, conversation and settings, that works only in that project. The Megachat of the IDE
stays as it is. The user adds a Megachat and removes it in Agent Sessions. `docs/air-contract.md` of Megachat has the
contract, in "The scopes of Megachat" and "The removal of a Megachat".

Megachat gives:

- The variable `MEGACHAT_PROJECT`: the absolute path of the project directory. A process of the entry with the variable
  is the Megachat of that project. A process without it is the Megachat of the IDE.
- The capability `projectScope` in `_meta.jetbrains.air.capabilities` of the answer of `initialize`, only in a project
  scope.
- The capability `agentStop` in the same list, always.
- The request `_agent/stop` with the parameters `{}`. The answer is `{ "stopped": true }`, or
  `{ "stopped": false, "reason": "<text>" }`.

Request to Air:

1. **The button and the menu action.** The button "Spawn Megachat" (with a plus) in the place of the launcher row of
   the application session, and the action "Spawn Megachat" in the menu of a project row and of a folder row of Agent
   Sessions. A stored application session of a present user stays a row.
2. **The record of the added Megachats.** Air keeps it in the state of the IDE. Before the user adds a Megachat, Air
   starts no command of the entry and shows no session row of Megachat.
3. **The Megachat of a project.** Air starts the command of the entry with `MEGACHAT_PROJECT=<directory>` added to the
   environment of the entry, one process for each project. It sends `session/new` with the project directory as `cwd`,
   and it shows the session as the first row of that project, in the same form as the row of the IDE.
4. **The check of `projectScope`.** A release of Megachat before this change ignores the variable and opens the
   conversation of the machine. For a process that Air started with the variable, an answer of `initialize` without
   `projectScope` must close the connection and tell the user to update Megachat.
5. **The action "Remove Megachat"**, for the row of the IDE and for the row of a project. Air sends `_agent/stop` to an
   agent that announced `agentStop`. When Air has no connection, it starts the command first. After `stopped: true`,
   Air removes the row and shows "Spawn Megachat" again. After `stopped: false`, Air shows `reason` and keeps the row.
   Without `agentStop`, Air removes only the row and says that the daemon continues to run until the command `stop`.

Notes for the implementation in Air:

- One `acp` process has one daemon and one conversation, so the process pool must not share a process between the IDE
  and a project, or between two projects.
- For a refused directory, `acp` exits with the code 1 and one line on its error output before `initialize`:
  "MEGACHAT_PROJECT names no project directory: <value>. ...". Megachat refuses the home directory, a directory that
  holds it, a hidden directory directly in it, and the state directory of Megachat.
- After `stopped: true`, the `acp` process ends its connection about 100 ms later and exits with the code 0. Each other
  `acp` process of the same daemon ends too. Air must not start the command again for a removed Megachat.
- The removal keeps the state directory. A new "Spawn Megachat" for the same directory gives the same conversation.
- Megachat registers only the directories of `_workspaces/list` that belong to the project, so Air needs no filter.

Evidence: `docs/air-contract.md` of Megachat, the capabilities `project-scope` and `agent-stop` in `openspec/specs/`
after the archive of the change `spawn-megachat`, and the tests `test/project-scope.test.mjs` and
`test/agent-stop.test.mjs`.
