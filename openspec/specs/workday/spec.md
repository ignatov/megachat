# workday Specification

## Purpose
The working day gives the working hours of the user. Outside the working hours, an idle conversation goes to sleep: the daemon sends no keep-alive request, and a child result waits for the user.

## Requirements

### Requirement: Working-day setting
The setting `workday.enabled` MUST be off by default. Off MUST keep each rule about the idle daemon (see the capability `keep-alive`).

A `settings.json` without the `workday.*` keys MUST open with the defaults.

Tests: `test/workday.test.mjs`, `test/settings.test.mjs`

#### Scenario: A settings.json without the working-day keys
- **WHEN** `settings.json` holds only `keepAlive.hours` with the value `3`
- **THEN** the settings give `workday.enabled` off, `workday.start` `09:00`, `workday.end` `19:00`, `workday.days` Monday to Friday, `workday.timezone` `auto` and `workday.idleMinutes` `30`, each from the default

#### Scenario: The keep-alive requests at night without the working day
- **WHEN** `workday.enabled` is off, the cache lifetime is 1 hour, and a turn ends on Wednesday at 23:00
- **THEN** the keep-alive requests go out at 23:50, 00:40, 01:30, 02:20, 03:10, 04:00 and 04:50, as without the working-day settings

### Requirement: Working hours
The working hours are from `workday.start` to `workday.end` (defaults `09:00` and `19:00`) on the days of `workday.days` (default Monday to Friday), in the timezone of `workday.timezone`. The value `auto`, the default, is the timezone of the system. The local time MUST come from `Intl`, so a change of the daylight saving time moves the working hours with the local clock.

Tests: `test/workday.test.mjs`

#### Scenario: The default working hours
- **WHEN** the working day has the defaults in the timezone `UTC`
- **THEN** Wednesday 09:00 and 18:59 are in the working hours, Wednesday 08:59 and 19:00 are not, and Saturday 12:00 is not

#### Scenario: Another timezone
- **WHEN** the working day has the defaults, and the time is Wednesday 2026-11-11 at 16:00 UTC
- **THEN** the time is in the working hours in the timezones `America/New_York` and `Europe/Berlin`, and not in the timezone `Asia/Tokyo`

#### Scenario: A change of the daylight saving time
- **WHEN** the timezone is `Europe/Berlin`, which leaves the summer time on Sunday 2026-10-25
- **THEN** 07:30 UTC is in the working hours on Friday 2026-10-23, where it is 09:30, and not on Monday 2026-10-26, where it is 08:30

### Requirement: Decision of the working time
A `workday.start` after `workday.end` MUST give working hours that go past midnight, from a working day into the next day. Equal times MUST give the whole day of each working day.

One pure function of the working-day settings and a time MUST decide whether the time is in the working hours.

Tests: `test/workday.test.mjs`

#### Scenario: Working hours past midnight
- **WHEN** `workday.start` is `22:00`, `workday.end` is `06:00`, and `workday.days` is Monday
- **THEN** Monday 23:00 and Tuesday 05:59 are in the working hours, and Tuesday 06:00 and Tuesday 23:00 are not

#### Scenario: Equal times
- **WHEN** `workday.start` and `workday.end` are both `00:00`
- **THEN** Wednesday 23:59 is in the working hours, and Saturday 12:00 is not

### Requirement: Keep-alive requests in the working hours
With `workday.enabled` on, the daemon MUST send no keep-alive request outside the working hours. In the working hours, the idle daemon MUST act as without the working day.

Tests: `test/workday.test.mjs`

#### Scenario: The end of the working hours
- **WHEN** the cache lifetime is 1 hour, and a turn ends on Wednesday at 17:00 UTC with the default working hours
- **THEN** keep-alive requests go out at 17:50 and 18:40, and no keep-alive request goes out after 19:00 or on the next morning without a turn

#### Scenario: A weekend
- **WHEN** a turn ends on Saturday at 12:00 with the default days
- **THEN** no keep-alive request goes out

### Requirement: Sleep of an idle conversation
Outside the working hours, the idle daemon MUST act only when the conversation is idle for `workday.idleMinutes` (default 30). Then the conversation MUST go to sleep: a context above the limit of a summary MUST get the summary one time through the summary of the idle daemon, and no request MUST go out until the next turn. A smaller context MUST get no summary. The log MUST get one line for the sleep.

Tests: `test/workday.test.mjs`

#### Scenario: A small conversation goes to sleep
- **WHEN** a turn ends at 17:00 UTC on a working day, and the context has 50000 tokens
- **THEN** no request goes out after 19:00, and the log gets the line "Outside the working hours, the idle conversation of 50000 tokens went to sleep. No keep-alive request goes out until the next turn." one time

#### Scenario: A large conversation after a long idle time
- **WHEN** `workday.idleMinutes` is `55`, the cache lifetime is 1 hour, and the turn of a large conversation ends at 19:10 UTC
- **THEN** the summary comes one time at 20:05, and the conversation goes to sleep

### Requirement: Summary after the cache lifetime
Outside the working hours, the summary MUST come at the end of the idle time also when the cache lifetime is over, for example with `cache.ttl=5m` or with an idle time above 50 minutes. The summary request sends the conversation as a transcript with its own system prompt and no cache retention, so it reads no prompt cache, and a cold cache does not change its cost.

Tests: `test/workday.test.mjs`

#### Scenario: A long idle time
- **WHEN** the cache lifetime is 1 hour, `workday.idleMinutes` is `120`, and the turn of a large conversation ends at 19:10 UTC
- **THEN** the summary comes one time at 21:10, after the cache lifetime

#### Scenario: The 5-minute cache
- **WHEN** `cache.ttl` is `5m`, and the turn of a large conversation ends at 19:10 UTC
- **THEN** the summary comes at 19:40, at the end of the default idle time of 30 minutes

### Requirement: Late timer in the working hours
In the working hours, a timer that comes after the cache lifetime MUST still do nothing, because the user is then likely back, and a summary would make the next turn wait.

Tests: `test/workday.test.mjs`

#### Scenario: A computer that slept
- **WHEN** the turn of a large conversation ends at 12:00 UTC on a working day, and the computer sleeps for 2 hours
- **THEN** the late timer sends no summary and no keep-alive request

### Requirement: Turns and child tasks outside the working hours
A turn outside the working hours MUST work as usual. After it, the idle rule MUST apply, and `keepAlive.hours` MUST NOT apply. A daemon restart outside the working hours MUST send no keep-alive request.

The first turn after the sleep MUST start from the context that the summary left.

The sleep MUST NOT stop a child task.

Tests: `test/workday.test.mjs`

#### Scenario: A turn at night
- **WHEN** a turn at 23:00 UTC completes, and the context has 50000 tokens
- **THEN** no keep-alive request goes out in the next 9 hours

#### Scenario: The first turn after the sleep
- **WHEN** the last turn ends at 18:30 UTC, the context is above the limit of a summary, and the next turn comes at 09:00
- **THEN** the summary comes one time at 19:20, no other request goes out in the night, and the turn at 09:00 starts from the context that the summary left

#### Scenario: A child task during the sleep
- **WHEN** a turn of the user at 23:00 UTC starts a child task, and the conversation then goes to sleep
- **THEN** the child task continues, it finishes at 02:00 with its result, and the result starts no turn before 09:00, the start of the next working day

### Requirement: Working day without the keep-alive
With `keepAlive.enabled` off, the working day MUST have no effect on the keep-alive requests and on the summary. The wait of the child results below stays.

Tests: `test/workday.test.mjs`

#### Scenario: The keep-alive is off
- **WHEN** `workday.enabled` is on, and `keepAlive.enabled` is set to off
- **THEN** the daemon sends no keep-alive request and writes no summary of an idle conversation, as with `keepAlive.enabled` off and `workday.enabled` off

### Requirement: Form of the working-day values
A time MUST be `HH:MM` or `H:MM` of a 24-hour clock, and the value MUST become `HH:MM`. The days MUST be a list or a text such as `mon-fri` or `mon,wed`, with short or full English names, and at least one day. A timezone MUST be `auto` or a name that `Intl` knows. The idle time MUST be a whole number of minutes from 0 to 1440.

Tests: `test/settings.test.mjs`, `test/workday.test.mjs`

#### Scenario: Times
- **WHEN** `workday.start` gets the value ` 7:05 `, `24:00`, `09:60` or `9am`
- **THEN** ` 7:05 ` becomes `07:05`, and the other values are refused

#### Scenario: Days
- **WHEN** `workday.days` gets the value `mon-fri`, ` Sat , sunday `, an empty list or `weekdays`
- **THEN** `mon-fri` becomes the days Monday to Friday, ` Sat , sunday ` becomes Saturday and Sunday, and the other values are refused

#### Scenario: Timezones and idle times
- **WHEN** `workday.timezone` gets `Europe/Berlin` or `Mars/Olympus`, and `workday.idleMinutes` gets `45`, `1441` or `1.5`
- **THEN** `Europe/Berlin` and `45` are accepted, and `Mars/Olympus`, `1441` and `1.5` are refused

### Requirement: Child results during the sleep
With `workday.enabled` on, a child result MUST start no turn while the conversation sleeps: outside the working hours, and idle for `workday.idleMinutes` since the end of the last turn of the user. The keep-alive and the wait of the results MUST use one shared pure function for this decision, `isSleeping` of `src/Workday.mjs`.

Tests: `test/waiting-results.test.mjs`

#### Scenario: A result at night
- **WHEN** the working day is on in the timezone `UTC`, no turn of the user came in the last 30 minutes, and a child result comes on Wednesday at 23:00
- **THEN** the result starts no turn, and it stays not reported

#### Scenario: The decision of the sleep
- **WHEN** the default working day is in the timezone `UTC`, and the time is Wednesday 23:00
- **THEN** the conversation sleeps when the last turn of the user ended at 22:00 or when no turn came, and it does not sleep when the last turn ended at 22:45

### Requirement: Child results at once
While the user is active outside the working hours, with a turn in the last `workday.idleMinutes`, a child result MUST start its turn at once.

With `workday.enabled` off, a child result MUST start its turn at once, at each time of the day.

Tests: `test/waiting-results.test.mjs`

#### Scenario: The user is active at night
- **WHEN** a turn of the user starts at 23:00, and a child result comes at 23:10
- **THEN** the result starts its turn at 23:10

#### Scenario: The working day is off
- **WHEN** `workday.enabled` is off, and a child result comes at 23:00
- **THEN** the result starts its turn at once

### Requirement: End of the idle time
Only a turn of the user MUST end the idle time of `workday.idleMinutes`, in the service and in the keep-alive. A turn of a child result, of the sessions summary and of the morning report MUST NOT end it, so a chain of child results at night does not keep the conversation awake: after a last turn of the user at 22:55, a result at 23:10 starts its turn, and a result at 23:35 waits.

Tests: `test/waiting-results.test.mjs`

#### Scenario: A chain of child results at night
- **WHEN** the last turn of the user ends at 22:55, a child result comes at 23:10, and another child result comes at 23:35
- **THEN** the first result starts its turn at 23:10, and the second result waits until 09:00 of the next working day

#### Scenario: The idle time of the keep-alive
- **WHEN** the cache lifetime is 1 hour, `workday.idleMinutes` is `55`, the last turn of the user ends at 22:55 UTC, and a turn of a child result of a large conversation ends at 23:10
- **THEN** the idle time ends at 23:50 and not at 00:05, and the summary comes one time at 00:00

### Requirement: Keep-alive window of automatic turns
In the working hours, a turn of a child result and a turn of the sessions summary MUST still start the `keepAlive.hours` window again.

Tests: `test/waiting-results.test.mjs`

#### Scenario: A result turn in the working hours
- **WHEN** the window is 6 hours, a turn of the user ends at 08:00, and a turn of a child result ends at 13:00
- **THEN** the last keep-alive request goes out at 18:50

### Requirement: End of the idle time after a restart
After a restart, the end of the last turn of the user MUST come from the state: the time when the state settled its input, else its admission time for an input of an earlier build. The inputs of the automatic turns have the request ID prefixes `children:`, `sessions:` and `morning:`.

Tests: `test/waiting-results.test.mjs`

#### Scenario: A restart after a result turn
- **WHEN** the state settled the last input of the user at 22:55, a result turn ended at 23:10, and the daemon starts again at 23:35 with a new child result
- **THEN** the new result waits, because the idle time starts at 22:55

#### Scenario: The inputs of the state
- **WHEN** the state has an input of the user that it settled at the time 260, and inputs with the prefixes `children:`, `sessions:` and `morning:` that it settled later
- **THEN** the end of the last turn of the user is 260, and for an input of an earlier build with only the admission time 100, it is 100

### Requirement: Release of the waiting results
The waiting results MUST go out at the first of these: right after the next turn of the user, or at `workday.start` of the next working day. A Friday night result goes out on Monday.

Tests: `test/waiting-results.test.mjs`

#### Scenario: The start of the next working day
- **WHEN** a child result waits from Wednesday 2026-11-11 at 23:00 UTC
- **THEN** its turn starts on Thursday 2026-11-12 at 09:00, and not one minute before

#### Scenario: A Friday night result
- **WHEN** a child result waits from Friday 2026-11-13 at 22:00 UTC
- **THEN** its turn starts on Monday 2026-11-16 at 09:00

#### Scenario: The next turn of the user
- **WHEN** a child result waits from 23:00, and the user sends a message at 23:30
- **THEN** the turn of the user runs first, and the turn of the result starts right after it at 23:30

### Requirement: Results that were ready at the end of a turn of the user
A result that was ready at the end of a turn of the user MUST go out right after that turn, also with `workday.idleMinutes` 0, when the conversation sleeps again at once after each turn of the user. A result that comes later MUST wait.

Tests: `test/waiting-results.test.mjs`

#### Scenario: No idle time
- **WHEN** `workday.idleMinutes` is `0`, a child result waits from 23:00 UTC, and the user sends a message at 23:30
- **THEN** the turn of the result starts right after the turn of the user at 23:30

#### Scenario: A result after the turn of the user
- **WHEN** `workday.idleMinutes` is `0`, the turn of the user ended at 23:30 UTC, and another child result comes at 23:35
- **THEN** the result starts no turn, and it stays not reported

### Requirement: Wait across a restart
The wait MUST survive a restart of the daemon: its end MUST come from the settings and the clock. The timer MUST look at the clock again at least every 15 minutes.

Tests: `test/waiting-results.test.mjs`

#### Scenario: A restart before the working day
- **WHEN** a child result waits from 23:00 UTC, the daemon stops, and a new daemon starts at 08:00 on the next working day
- **THEN** no turn starts before 09:00, and the turn of the result starts at 09:00

### Requirement: Permission requests during the wait
A permission request of a child MUST show at once. Only the turn of the result waits.

Tests: `test/waiting-results.test.mjs`

#### Scenario: A permission request at night
- **WHEN** a child result waits at 23:00 UTC, and another child asks for the permission "Write a file"
- **THEN** the connected client gets the permission request at once, and the result stays not reported

### Requirement: Waiting results before the morning report
With `report.morning` on, the turn of the waiting results MUST come before the turn of the morning report, because the event pump starts the result turns first. The data of the report MUST mark each finished child run without a reported result with `separateResult: true`, and the rules of the report MUST ask the main agent to name it in a few words and not to tell its result again.

Tests: `test/waiting-results.test.mjs`

#### Scenario: A Sunday night result and the Monday report
- **WHEN** `workday.enabled` and `report.morning` are on, and a child result waits from Sunday 22:00 UTC
- **THEN** on Monday at 09:00 the turn of the result comes first and the turn of the morning report comes next, and the data of the report marks the run with `separateResult: true`

### Requirement: Ended runs in the list of the tasks
`agents_list` MUST give each ended run without a reported result `separateResult: true`, as the data of the morning report does. The rules MUST tell the main agent that such a task ended and that its result comes in its own message after this turn. So in the turn of the user before a waiting result, the main agent does not say that the task has no result.

Tests: `test/waiting-results.test.mjs`

#### Scenario: A list before a waiting result
- **WHEN** a child run completed at 23:00 UTC, its result waits, and the main agent calls `agents_list` in a turn of the user at 23:30
- **THEN** the list gives the run with the status `completed` and `separateResult: true`, the rules say "A listed task with separateResult true ended, and its result comes in its own message after this turn.", and the result turn follows the turn of the user

#### Scenario: A list after the result message
- **WHEN** the result message of the run came
- **THEN** `agents_list` gives the run without `separateResult`

### Requirement: Inspection of an ended run
`agents_inspect` of an ended run MUST mark its result as reported, also while the result waits. The main agent then has the result in this turn, and no result message repeats it.

Tests: `test/waiting-results.test.mjs`

#### Scenario: An inspection while the result waits
- **WHEN** a child run completes at 00:10 UTC with the output "Result read.", its result waits, and the main agent calls `agents_inspect` of the run in the next turn of the user
- **THEN** the inspection gives the output "Result read." and marks the result as reported, and no result turn follows
