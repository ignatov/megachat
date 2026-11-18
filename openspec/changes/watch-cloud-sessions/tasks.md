# Tasks

## 1. Setting

- [x] 1.1 Add `cloud.sessions` to `SETTINGS` of `src/Settings.mjs`: `on` or `off`, the default `off`, `applies: 'cloud'`. Add `setting.cloud.sessions` and `settings.applies.cloud` to `resources/Megachat.properties`. Add the default, the accepted values `true` and ` Off ` and the refused value `soon` to `test/settings.test.mjs`, and verify that `npm test` passes.

## 2. Detection and read of airc

- [x] 2.1 Add `locateAirc` to the new module `src/CloudSessions.mjs`: one `central plugins` call with a time limit of 10 seconds, the line of `airc` with the state `active`, and the `executable` of `manifest.json` in its `source`. Verify with cases in the new `test/cloud-sessions.test.mjs` with a fake `central`: an active plugin, a disabled plugin, no line, and a missing executable (requirement "Detection of airc").
- [x] 2.2 Add `readCloudSessions`: `airc sessions --limit 50`, a time limit of 30 seconds, the `PATH` of Central first, a JSON array of objects with a string `id`, else an error with the exit code and the first line of the error output, at most 200 characters. Verify with a fake `airc`: the arguments, a list, the code 1 with `no credential`, the output `{"error":true}`, and a time limit (requirement "Failed read of the list").

## 3. Plan and text of a cloud note

- [x] 3.1 Add `planCloudNotes`, `pruneCloudRecords` and the statuses of a note (`FINISHED`, `USER_INPUT_REQUIRED`, `ERROR`, `ABORTED`) to `src/CloudSessions.mjs`. Verify with cases for the first read of a watch, the changes after the start, no second note for the same status, a session that runs again, the renewal of a record after 1 day, and 210 records with 5 old ones (requirements "Statuses of a cloud note", "One note for each status" and "Limits of the cloud records").
- [x] 3.2 Add `cloudNoteText` and the strings `cloud.note.*` to `resources/Megachat.properties`. Verify with the cases "Two sessions in one note" and "Twelve sessions" (requirement "Text of a cloud note").

## 4. State and timer

- [x] 4.1 Add `MegachatState.cloudWatch(on, now)` for `cloudSessions.since` and `MegachatState.cloudNote(plan, now)` for the note and the records, with one private helper that `sessionNote` uses too. Verify that `test/session-notes.test.mjs` still passes, that a read without a change commits nothing, and that the records hold no name, no ID and no repository.
- [x] 4.2 Add `CloudWatch` to `src/CloudSessions.mjs`: a read at once, then every 2 minutes, no `airc` while the conversation sleeps, a stop at off, and a read at the end of a turn when a note waits. Add the log lines `log.cloud`, `log.cloud.failed` and `log.cloud.missing`. Verify with the cases "Reads every 2 minutes", "A night" and "Off stops the reads" (requirement "Reads of the list").

## 5. Service

- [x] 5.1 Wire the cloud sessions in `src/PiMegachatService.mjs`: the option `cloud` (`central`, `environment`, `locate`, `list`), the detection in `open`, in `settingsTool` and in `applySettings`, `cloudState` in `adopt`, the timer in `resume`, at the end of a turn and in `close`. Pass the path and the `PATH` of Central from `src/main.mjs`. Verify with the cases "The cloud sessions are off by default", "No airc" and "The agent turns the cloud sessions on".
- [x] 5.2 Add the tool `agents_cloud` with `status` and `limit`, and its description `tool.cloud`. Verify with the cases "The list", "A filter and the default limit" and "airc ends with an error" (requirements "Tool of the cloud sessions" and "Filter of the tool").
- [x] 5.3 Add the rules lines `instructions.cloud` and `instructions.cloud.missing` to `settingsRules`. Verify with the case "The rules in the three states" (requirement "Rules of the cloud sessions").
- [x] 5.4 Verify the delivery through the service: the cases "Two notes and the model", "A note during a turn", "A restart of the daemon" and "The log line of a cloud note" (requirements "Delivery of a cloud note", "One note for each status" and "Private data of the cloud sessions").

## 6. Morning report

- [x] 6.1 Add the part `cloud` to `collectReportData` in `src/MorningReport.mjs` and pass the read from `prepareMorningReport` only with `cloudState` `on`. Add one sentence about the part to `event.morning.rules`. Verify with the cases "Cloud sessions of the period" and "The cloud sessions are off or airc fails" in `test/morning-report.test.mjs`.

## 7. Documents and checks

- [x] 7.1 Add a section "The cloud sessions" to `README.md`: the setting, the plugin `airc`, the tool, the notes, the report part, the reads every 2 minutes, and what Megachat cannot do. Add the new module to the code map. Verify that each setting, status and time in the section is the same as in the specs.
- [x] 7.2 Run `locateAirc` and `readCloudSessions` against the real `central` and `airc` of this machine, without a daemon, and record the result without a name or an ID of a session in `docs/manual-checks.md`.
- [x] 7.3 Verify that each `Tests:` line of the change names a test file with a case for it, that `npx @fission-ai/openspec@1.17.0 validate --all --strict` passes, and that `npm test` passes.

## Workflow follow-up

- Archive the change with `/opsx:archive` after the review of the pull request, and run `openspec validate --all --strict` after the merge of the specs.
