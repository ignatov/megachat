## MODIFIED Requirements

### Requirement: End of a turn after a lost wake-up
A turn MUST end when the tool calls of its step ended, also when the end of the last tool task comes while the scheduler of Pi Durable plans a pass. Megachat MUST NOT write a task record of Pi Durable for this. Pi Durable 1.5.0 lost the wake-up of the step in this case (issue #25), and Pi Durable 1.5.1 has the fix.

Tests: `test/scheduler-wake.test.mjs`

#### Scenario: Two tool calls in one reply
- **WHEN** the main agent starts two tasks with `agents_spawn` in one reply, and the end of each tool task comes 0 to 300 microtasks late
- **THEN** each turn ends, the conversation has no current turn, and the next model request of the main agent has the two tool results

#### Scenario: Three tool calls in one reply
- **WHEN** the main agent starts three tasks with `agents_spawn` in one reply, and the end of each tool task comes 0 to 300 microtasks late
- **THEN** each turn ends, the conversation has no current turn, and the next model request of the main agent has the three tool results

## REMOVED Requirements

### Requirement: Guard for a lost wake-up of the scheduler
**Reason**: Pi Durable 1.5.1 fixed the lost wake-up. Without the guard, each turn of the scan ends at each delay 0 to 300, with two, three and five tool calls in one reply. With the guard on 1.5.1, the guard wrote no record. The guard used the internal `setTask` of the Pi Durable transaction.
**Migration**: None. The requirement "End of a turn after a lost wake-up" keeps the behavior, and its test fails when a later version of Pi Durable loses the wake-up again.

### Requirement: Writes of the guard
**Reason**: The guard goes, so it writes no record and no log line.
**Migration**: None. The log of the daemon no longer has the line "The task <ID> of Pi Durable waited after the end of each task of its wait. Megachat wrote its record again, so the scheduler runs it."
