# Roadmap

The later work on Megachat, in the order of the work. Each item gives its reason in one line.

1. **Checks before the handover to colleagues.** Today nobody checked the `npx` entry on the machine of a colleague,
   and these risks stay open:
   - A stalled network makes the start wait without end. With a proxy that accepts each connection and never answers,
     `npx` did not end in 180 seconds. Find a limit that works, such as `GIT_HTTP_LOW_SPEED_LIMIT` in the `env` of the
     entry, and measure what the user sees.
   - Without the network, Megachat does not start, also with a copy in the cache: `npx` ends with the exit code 128
     and prints nothing. Two later starts on the network also ended at once with the exit code 128, and the npm log
     does not give the reason.
   - A later start of the same release can write the files of the copy while its daemon and a child agent run from
     them. Nobody tested whether the daemon survives.
   - Two project windows can start the entry at the same time, with an empty or a full cache. Nobody tested whether
     both get an answer.
   - Nobody tested what happens to an unfinished delegated task when a new release replaces the daemon.
   - The script `build` of `package.json` makes npm prepare the git package: npm installs each dependency again in a
     temporary clone before it packs the copy. Nobody measured how much a script with another name saves.
   - npm skips an optional package that it cannot download. In one run of `npm run test:package`, a copy got no
     `@openai/codex-darwin-arm64`, so its Codex agent failed. Nobody tested whether a later start of the `npx` entry
     repairs such a copy.
   - `install` does not check that the IDE build has the Air support for Megachat.
2. **A Stop action on each running job.** Send `canStop: true` and handle `_session/async_task/stop` for one child.
   Today the user can stop one child only through a message to the main agent.
3. **Child agents that run at the same time.** Today one child runs at a time, so a long task blocks each queued task.
4. **One layer for Central.** Remove the `bin/pi` shim, the read of `~/.claude/settings.json`, and the `bin/codex` shim.
   Today three different paths get the Central configuration, and each path can fail in its own way.
5. **CI, Linux support, and a lock of the installed copy.** Today only one macOS machine runs the tests and makes
   each release, and nobody tested Linux. The installed copy does not use `package-lock.json`, so its indirect
   dependencies can differ from the tested ones. npm also ignores an `npm-shrinkwrap.json` in a package from git: a
   test installed 18 packages of 223 in a later version. So the lock needs another form of the release.
6. **A choice of the model for the children.** The setting `coordinator.model` selects the model of the main agent.
   Today the code sets Claude Sonnet 5.5 for each Claude child.
7. **IDE tools for the children.** Today a child cannot use the tools of the IDE, so it cannot use the code insight
   of the project.
8. **Types: TypeScript, or `tsc --checkJs`.** Today no type check runs, so a wrong field name shows only in a test or
   at run time.
9. **A login service, so the daemon starts with the system.** Today no daemon runs after a restart of the computer
   until an IDE opens Megachat, so no project change gets a proposal until then.
10. **One record request for many delegated sessions.** Send the addresses in one batch, or only the addresses that
    Air does not know. Today each attach sends one `_session/service/record` for each address, up to 5,000.
11. **A refusal text of its own for each limit of work in progress.** Today `error.limit` names a time or output
    limit also for eight child runs of one main task, eight unfinished tasks, and 32 permissions of one run. So the
    model does not see the real reason.
