// A test loads this module with `--import` in `NODE_OPTIONS` into a Megachat process tree. In a daemon process, it
// appends the process id to the file that `MEGACHAT_TEST_SLOW_DAEMON` names, and then it blocks before Megachat loads.
import { writeFileSync } from 'node:fs'

if (process.argv[2] === 'daemon') {
  writeFileSync(process.env.MEGACHAT_TEST_SLOW_DAEMON, `${process.pid}\n`, { flag: 'a' })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000)
}
