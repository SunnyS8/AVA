/**
 * GET /chat/history — paged conversation history for the desktop chat channel.
 *
 * Auth: Bearer JWT (HS256) from the wizard. Payload.sub is treated as the
 * workspace id; the handler does not enforce additional ACLs because the JWT
 * issuer already binds the token to a single workspace.
 *
 * Query params:
 *  - before: optional message-id cursor. Without it, returns the latest page.
 *  - limit:  optional, 1..200, default 50.
 *
 * Response: { messages: Message[], hasMore: boolean }. Messages are returned
 * newest-first within the page (the renderer reverses for display).
 */
import type http from 'node:http'
import type { Message } from './types.js'
import type { Conversation } from '../memory/types.js'

export interface HistoryHandlerDeps {
  /** Returns the decoded payload `{ sub: workspaceId }` or null. */
  verifyJwt: (token: string) => { sub: string } | null
  /** Backed by ConversationRepo.listBefore. */
  listBefore: (
    workspaceId: string,
    beforeId: string | null,
    limit: number,
  ) => Promise<Conversation[]>
}

function convToMessage(c: Conversation): Message {
  // Conversation.channel can be 'cabinet' (legacy), 'telegram', 'max',
  // 'desktop'. Map 'cabinet' (a no-longer-used internal channel) to 'desktop'
  // for the wire protocol — it's the closest semantic match and chat-protocol
  // does not expose 'cabinet'.
  const ch: Message['channel'] =
    c.channel === 'cabinet' ? 'desktop' : (c.channel as Message['channel'])
  // Assistant tool-call rows are not user-visible messages — skip them later.
  return {
    id: c.id,
    role: c.role as Message['role'],
    text: c.content,
    channel: ch,
    createdAt: c.createdAt.toISOString(),
  }
}

export function createHistoryHandler(
  deps: HistoryHandlerDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const auth = req.headers.authorization ?? ''
    const m = /^Bearer\s+(.+)$/i.exec(auth)
    if (!m) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'missing bearer token' }))
      return
    }
    const payload = deps.verifyJwt(m[1])
    if (!payload) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid token' }))
      return
    }

    const url = new URL(req.url ?? '/', 'http://x')
    const before = url.searchParams.get('before')
    const rawLimit = parseInt(url.searchParams.get('limit') ?? '50', 10)
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 200)

    const convs = await deps.listBefore(payload.sub, before, limit)
    // Drop tool rows — they're not user-visible chat messages.
    const messages = convs
      .filter((c) => c.role === 'user' || c.role === 'assistant')
      .map(convToMessage)
    const body = { messages, hasMore: convs.length === limit }

    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    })
    res.end(JSON.stringify(body))
  }
}
