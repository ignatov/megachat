# Roadmap

The later work on Megachat, in the order of the work. Each item gives its reason in one line.

1. **A Stop action on each running job.** Send `canStop: true` and handle `_session/async_task/stop` for one child.
   Today the user can stop one child only through a message to the main agent.
2. **Child agents that run at the same time.** Today one child runs at a time, so a long task blocks each queued task.
3. **One layer for Central.** Remove the `bin/pi` shim, the read of `~/.claude/settings.json`, and the `bin/codex` shim.
   Today three different paths get the Central configuration, and each path can fail in its own way.
4. **An install for colleagues.** Add a command that writes the `acp.json` entry, CI, and Linux support.
   Today the install is manual, and only one macOS machine runs the tests.
5. **A choice of the model for the main agent and for the children.** Today the code sets Claude Opus 5.5 for the
   main agent and Claude Sonnet 5.5 for each Claude child.
6. **IDE tools for the children.** Today a child cannot use the tools of the IDE, so it cannot use the code insight
   of the project.
7. **Types: TypeScript, or `tsc --checkJs`.** Today no type check runs, so a wrong field name shows only in a test or
   at run time.
8. **A login service, so the daemon starts with the system.** Today no daemon runs after a restart of the computer
   until an IDE opens Megachat, so no project change gets a proposal until then.
9. **One record request for many delegated sessions.** Send the addresses in one batch, or only the addresses that
   Air does not know. Today each attach sends one `_session/service/record` for each address, up to 5,000.
10. **A refusal text of its own for each limit of work in progress.** Today `error.limit` names a time or output
    limit also for eight child runs of one main task, eight unfinished tasks, and 32 permissions of one run. So the
    model does not see the real reason.
