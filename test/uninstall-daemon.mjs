// A fake daemon of a state directory for `test/uninstall.test.mjs`. It publishes `daemon/connection.json` and answers
// `/health`, `/state` and `/shutdown` as a daemon does. The test sends the value of `/state` as an IPC message. With
// the mode `stay`, the process does not end after `/shutdown`.
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [directory, mode] = process.argv.slice(2)
const token = randomBytes(32).toString('hex')
let state = { current: null, runs: {} }
const server = createServer((request, response) => {
  const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
  if (request.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' })
  if (request.url === '/health') return send(200, { version: 1, pid: process.pid })
  if (request.url === '/state') return send(200, state)
  if (request.url !== '/shutdown') return send(404, { error: 'missing' })
  send(200, { stopping: true })
  // A daemon removes its connection file in its shutdown.
  if (mode !== 'stay') setImmediate(async () => { await rm(join(directory, 'daemon', 'connection.json'), { force: true }); process.exit(0) })
})
server.listen(0, '127.0.0.1', async () => {
  await mkdir(join(directory, 'daemon'), { recursive: true, mode: 0o700 })
  await writeFile(join(directory, 'daemon', 'connection.json'), JSON.stringify({ version: 1, pid: process.pid, port: server.address().port, token }),
    { mode: 0o600 })
  process.send('ready')
})
process.on('message', value => { state = value; process.send('changed') })
