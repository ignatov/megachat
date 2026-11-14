# Design

## Context

See `proposal.md`, part "Why". Each change of the status of a run goes through `MegachatState`: `admitChild`,
`transition`, `cancel`, `stopChild` and `recover`. The run services (`AcpRunService`, `PiRunService`) only call
`transition`.

## Decisions

### 1. The lines go out of the state, after the commit

One place sees all paths: spawn, send, resume, the stop for a message, the recovery after a restart, and the time
limit. A commit can run its function again, so each function keeps the data of its lines in a variable that it resets
at its start, and writes the lines after the commit. A repeated request ID writes no start line.

### 2. The start is the admission

The start line goes out when the run is admitted, not when its agent process starts. A run that waits in the queue, or
that never starts, still has a line. A continuation (`continue`, `recovery`, `steer-restart`, `steer-followup`) writes
its start line in the commit that ends the run before it, after the end line of that run.

### 3. The class comes from the run service

The run service knows why a run failed, so `transition` takes the class as a fourth argument. The state does not keep
it. A time limit gives the class `timeout` and the status `timeout` in the log, and the state keeps `interrupted`.

### 4. No content

The start line quotes the title and the directory as JSON text. The error line holds the first sentence of the error
text. The text of an agent comes after that sentence (`childFailure`), so it never reaches this line. `log.child.*`
keeps the filtered answer and the error output as before.

### The admitted work and the state

No state file and no field changes. A restart writes the end and the start lines of the runs that it interrupts, in
`recover`. No ACP message and no `_meta` key changes.

## Risks / Trade-offs

- [A crash between the commit and the line] → the line is lost. The state is right, and the log is a trace only.
- [A pi run that continues after a restart] → `recover` skips it, so it writes no end line at the restart.
