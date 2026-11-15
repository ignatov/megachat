# Draft of an Air ticket (not filed)

Title: A public way to archive an ACP thread from outside the IDE process

Megachat (an ACP agent) archives agent sessions. For a session without a thread of Air, the title records of the
agent log are enough, and Air takes them on a refresh. For a session that has its own thread of Air (`local:<id>`,
for example `importedExistingSession`), Air shows the session until the user presses Done: the state is
`summary.archived`, and the archive event is written inside the IDE process by
`StructuredSessionReplicaServiceImpl.setArchived`.

An external writer cannot do the same safely. `events.jsonl` has no lock. `StorageSessionState.nextSeq` and the
projection of the thread are in memory, so a line that an outside process appends gets a `seq` that the next event of
Air takes again, and the summary that Air writes later overwrites the change.

Request: one of these.
1. An ACP extension method or a command that archives and unarchives a thread by its agent session ID, with the same
   steps as Done.
2. An inbox file in the thread directory that Air reads again and applies through `setArchived`.
3. A refresh of the list that also reads `[archived] ` for a thread that has `summary.archived` unset, and a rule that
   Megachat may clear.

Evidence: `docs/air-contract.md` of Megachat, "The archive of a session that has a thread of Air".
