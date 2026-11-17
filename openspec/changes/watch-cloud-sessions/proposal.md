# Proposal

## Why

The user runs agents in Air Cloud too, from Air, Air Web and the automations. Megachat sees only the agent sessions on
this machine. So a cloud session that finished, failed or waits for the input of the user stays unseen until the user
opens Air Web. The plugin `airc` of JetBrains Central lists the cloud sessions of the Central login. Megachat already
needs Central and its login, so it can read the same list with no new login.

## What Changes

Where it shows: the chat (a tool answer, a note and the morning report), the output of `agents_settings`, and the log.

- A new setting `cloud.sessions`, `on` or `off`. The default is `off`. The cloud sessions also need the plugin `airc` of
  Central: `central plugins` must show it as `active`. Megachat looks for it at the start of the daemon and at each set
  or reset of `cloud.sessions`.
- With the setting on and `airc` found, the main agent gets the new tool `agents_cloud`. It lists the cloud sessions:
  the ID, the name, the status, the comment of the status, the agent, the repositories with the results branch, the
  last change and the task ID. The tool only reads. It cannot start, cancel or continue a cloud session.
- With the setting on and `airc` found, the daemon reads the list every 2 minutes while the conversation is awake. When
  a cloud session changes to `FINISHED`, `USER_INPUT_REQUIRED`, `ERROR` or `ABORTED`, Megachat writes a note in the chat
  (see the capability `session-notes`). A note costs no model request. A session gets one note for each status. A
  change from before the start of the watch gives no note.
- The morning report gets the cloud sessions: the sessions that finished or failed in the period, and the sessions that
  run or wait for the user now.
- With the setting on and no `airc`, there is no tool, no read and no report part. `agents_settings` and the rules of
  the main agent say why.
- The log gets the count of the sessions of a note, and the outcome of a read of `airc`. It gets no name and no ID of
  a cloud session.

The change does not modify an ACP extension. Air does not change. `docs/air-contract.md` does not change.

## Capabilities

### New Capabilities

- `cloud-sessions`: the setting `cloud.sessions`, the detection of `airc`, the tool `agents_cloud`, the read of the
  list, the notes about the cloud sessions, and the rules of the main agent for them.

### Modified Capabilities

- `morning-report`: the requirement "Content of the data" gets the cloud sessions.

## Impact

- New module `src/CloudSessions.mjs`: the detection of `airc`, the read of the list, the plan and the text of a note,
  and the timer of the reads.
- `src/PiMegachatService.mjs`: the tool, the rules line, the status in `agents_settings`, the timer in `resume` and in
  `close`.
- `src/MegachatState.mjs`: the commit of a cloud note and the new state field `cloudSessions`.
- `src/MorningReport.mjs`: the part `cloud` of the data.
- `src/Settings.mjs`: the setting `cloud.sessions`.
- `src/main.mjs`: the path of `central` for the detection.
- `resources/Megachat.properties`: the tool description, the setting, the note, the rules and the log lines.
- `README.md`: a new section about the cloud sessions.
- New test `test/cloud-sessions.test.mjs`, and new cases in `test/morning-report.test.mjs` and `test/settings.test.mjs`.
- No new dependency. No change of `package.json`, of `build.mjs` or of the launcher.

Out of scope:

- A start, a cancel, a follow-up message or a resume of a cloud session. They cost credits or end work, so they need a
  dialog and a proposal of their own. design.md, decision "A tool of its own", gives the plan for that change: a flag
  `cloud` on the tools of the child runs.
- The credits of a cloud session. The default output of `airc sessions` has no credits. The output of `--verbose` is
  the wire type of the agent spawner, and it has no stable shape.
- A link to the task in Air Web. The output of `airc` has no organization ID.
- A cloud session in the task list of Air. That is an ACP extension and a change of Air.
- A cloud session as a child task of Megachat.
- A read while the conversation sleeps, and a period with only cloud sessions as an active period of the morning report.
- An `airc` outside Central, and the Air CLI `aircli`.

The change touches no non-goal.
