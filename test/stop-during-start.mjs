// A test loads this module with `--import` into a daemon process, so the daemon gets a stop in the middle of its start.
// `MEGACHAT_TEST_STOP=signal` sends SIGTERM to the daemon when it has the owner lock, before it opens the conversation.
// The signal waits for the next turn of the event loop, because the daemon adds its signal handlers after it got the
// lock, and SIGTERM without a handler ends the process at once. `MEGACHAT_TEST_STOP=storage` gives a storage error when
// the daemon listens, before it starts the children and publishes the connection file.
import { DaemonDirectory } from '../src/DaemonDirectory.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'

if (process.argv[2] === 'daemon' && process.env.MEGACHAT_TEST_STOP === 'signal') {
  const acquire = DaemonDirectory.acquire
  DaemonDirectory.acquire = async function (...args) {
    const owner = await acquire.apply(this, args)
    setImmediate(() => process.kill(process.pid, 'SIGTERM'))
    return owner
  }
}
if (process.argv[2] === 'daemon' && process.env.MEGACHAT_TEST_STOP === 'storage') {
  const open = PiMegachatService.open
  PiMegachatService.open = async function (...args) {
    const service = await open.apply(this, args)
    const failure = Promise.withResolvers()
    service.failed = failure.promise
    const listen = DaemonServer.prototype.listen
    DaemonServer.prototype.listen = async function (...listenArgs) {
      const descriptor = await listen.apply(this, listenArgs)
      const error = new Error('A storage error of the test')
      error.code = 'ERR_TEST_STORAGE'
      failure.resolve(error)
      return descriptor
    }
    return service
  }
}
