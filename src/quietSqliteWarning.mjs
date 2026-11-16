// Import this module before any module that imports `node:sqlite`. Node.js 22 to 25.6 emits an ExperimentalWarning
// for `node:sqlite` at the first import, and the default handler prints it on the error output. Megachat uses a fixed
// API of `node:sqlite`, so the warning only hides the real lines of an install or a start. This wrapper drops that one
// warning and passes each other warning to the handlers that were there.
const handlers = process.listeners('warning')
process.removeAllListeners('warning')
process.on('warning', warning => {
  if (warning?.name === 'ExperimentalWarning' && /^SQLite\b/.test(warning.message ?? '')) return
  for (const handler of handlers) handler.call(process, warning)
})
