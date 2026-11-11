// A test loads this module with `--import` in `NODE_OPTIONS` into a Megachat process tree. In a daemon process, it
// appends the process id to the file that `MEGACHAT_TEST_SLOW_DAEMON` names, and then it blocks before Megachat loads.
// `MEGACHAT_TEST_SLOW_DAEMON_MS` gives the time of the block, 15 seconds without it. With
// `MEGACHAT_TEST_SLOW_DAEMON_EXIT`, the daemon process ends with that exit code and does not block.
import { writeFileSync } from 'node:fs'

if (process.argv[2] === 'daemon') {
  writeFileSync(process.env.MEGACHAT_TEST_SLOW_DAEMON, `${process.pid}\n`, { flag: 'a' })
  if (process.env.MEGACHAT_TEST_SLOW_DAEMON_EXIT) process.exit(Number(process.env.MEGACHAT_TEST_SLOW_DAEMON_EXIT))
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.MEGACHAT_TEST_SLOW_DAEMON_MS ?? 15000))
}
