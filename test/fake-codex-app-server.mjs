import { createInterface } from 'node:readline'

const cwd = process.argv[2]
const thread = id => ({ id, cwd, name: 'Stored conversation', updatedAt: 1794310000 })
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  let result
  switch (request.method) {
    case 'initialize': result = {}; break
    case 'thread/list': result = { data: [thread(request.params.archived ? 'archived' : 'active')], nextCursor: null }; break
    case 'thread/read': result = { thread: thread(request.params.threadId) }; break
    case 'thread/turns/list': result = { data: [{ items: Array.from({ length: 25 }, (_, index) => ({
      id: String(index), type: index % 2 ? 'agentMessage' : 'userMessage', text: `Answer ${index}`,
      content: [{ type: 'text', text: `Question ${index}` }],
    })) }], nextCursor: null }; break
    default: process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32601, message: 'Unexpected mutation' } })}\n`); continue
  }
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`)
}
