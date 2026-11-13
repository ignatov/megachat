import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { megachatVersion } from './MegachatBuild.mjs'
import { message } from './messages.mjs'

/** Exposes the retained conversation to child tasks through a read-only MCP tool. */
export class MegachatHistoryServer {
  constructor(service) { this.service = service }

  async handle(request, response, body) {
    const server = new McpServer({ name: 'megachat-history', version: megachatVersion() }, {
      instructions: message('history.instructions'),
    })
    server.registerTool('history', {
      description: message('tool.history'),
      inputSchema: { beforeEntryId: z.number().int().positive().optional(), query: z.string().max(200).optional(), cursor: z.string().max(20).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async args => ({ content: [{ type: 'text', text: JSON.stringify(await this.service.history(args)) }] }))
    server.registerTool('sessions', {
      description: message('tool.sessions'),
      inputSchema: { cwd: z.string(), agent: z.enum(['claude', 'codex', 'pi', 'all']).optional(), query: z.string().max(200).optional(), cursor: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async args => ({ content: [{ type: 'text', text: JSON.stringify(await this.service.sessions.search(args)) }] }))
    // The tool of the children has no `order`, so it has a text of its own without the read from the end.
    server.registerTool('session_history', {
      description: message('history.session_history'),
      inputSchema: { cwd: z.string(), agent: z.enum(['claude', 'codex', 'pi']), sessionId: z.string(), query: z.string().max(200).optional(), cursor: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async args => ({ content: [{ type: 'text', text: JSON.stringify(await this.service.sessions.read(args)) }] }))
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    response.once('close', () => server.close().catch(() => {}))
    try {
      await server.connect(transport)
      await transport.handleRequest(request, response, body)
    }
    catch (error) { await server.close(); throw error }
  }
}
