/**
 * P1.5 — DesktopAdapter: WebSocket channel adapter for the Electron desktop
 * app. Implements the same `ChannelAdapter` contract as Telegram/Max so the
 * `BotRouter` can dispatch through it unchanged.
 *
 * Lifecycle:
 *  - `handleUpgrade(req, socket, head)` is the entry point the host HTTP
 *    server calls on 'upgrade'. Verifies the JWT bearer header, accepts the
 *    WS handshake, and registers the new connection.
 *  - Inbound `user-message` frames become `InboundEvent`s and fan out to
 *    handlers registered via `onMessage`.
 *  - Outbound messages (assistant replies) are broadcast to every active
 *    connection for the same workspace (`broadcastToWorkspace`).
 *  - `mirror(workspaceId, message)` is used by the `OutboundDispatcher` to
 *    forward messages from other channels (Telegram) for live sync.
 */
import http from 'node:http'
import type { Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket as WS } from 'ws'
import type {
  ChannelAdapter,
  InboundEvent,
  OutboundMessage,
  SendResult,
  StreamableOutbound,
} from './base.js'
import type { Message, ServerMessage } from '../chat/types.js'
import { log } from '../observability/logger.js'

export interface DesktopAdapterDeps {
  /** Same shape as P1.A: returns { sub: workspaceId } or null. */
  verifyJwt: (token: string) => { sub: string } | null
}

interface Conn {
  socket: WS
  workspaceId: string
}

/** Max time we will wait for a finalTextOverride promise. */
const FINAL_TEXT_OVERRIDE_TIMEOUT_MS = Number(
  process.env.BC_FINAL_TEXT_OVERRIDE_TIMEOUT_MS ?? 12_000,
)

export class DesktopAdapter implements ChannelAdapter {
  readonly name = 'desktop' as const
  private wss = new WebSocketServer({ noServer: true })
  private connections = new Set<Conn>()
  private inboundHandlers: ((ev: InboundEvent) => Promise<void>)[] = []

  constructor(private deps: DesktopAdapterDeps) {
    this.wss.on('connection', (socket: WS, _req: http.IncomingMessage, workspaceId: string) => {
      const conn: Conn = { socket, workspaceId }
      this.connections.add(conn)
      log().info('desktop: connection open', {
        workspaceId,
        total: this.connections.size,
      })
      socket.on('close', (code) => {
        this.connections.delete(conn)
        log().info('desktop: connection close', {
          workspaceId,
          code,
          remaining: this.connections.size,
        })
      })
      socket.on('error', () => {
        // ws emits both error and close — let close handle cleanup
      })
      socket.on('message', async (raw) => {
        let msg: any
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          this.safeSend(socket, {
            type: 'error',
            code: 'bad-json',
            message: 'message must be valid JSON',
          })
          return
        }

        if (msg?.type === 'ping') {
          this.safeSend(socket, { type: 'pong' })
          return
        }

        if (msg?.type === 'user-message') {
          if (typeof msg.text !== 'string' || typeof msg.clientMessageId !== 'string') {
            this.safeSend(socket, {
              type: 'error',
              code: 'bad-frame',
              message: 'user-message requires text and clientMessageId',
            })
            return
          }
          const ev: InboundEvent = {
            channel: 'desktop',
            chatId: workspaceId,
            userId: workspaceId,
            userDisplay: 'desktop',
            text: msg.text,
            messageId: msg.clientMessageId,
            timestamp: new Date(),
            isVoiceMessage: false,
            raw: msg,
          }
          for (const handler of this.inboundHandlers) {
            try {
              await handler(ev)
            } catch (e) {
              log().warn('desktop: inbound handler threw', {
                workspaceId,
                error: e instanceof Error ? e.message : String(e),
              })
            }
          }
          return
        }

        this.safeSend(socket, {
          type: 'error',
          code: 'unknown-type',
          message: `unknown message type: ${msg?.type}`,
        })
      })
    })
  }

  async start(): Promise<void> {
    // No-op: per-connection lifecycle is driven by handleUpgrade.
  }

  async stop(): Promise<void> {
    for (const c of this.connections) {
      try {
        c.socket.close(1001, 'server-stop')
      } catch {
        // ignore
      }
    }
    this.connections.clear()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
  }

  onMessage(handler: (ev: InboundEvent) => Promise<void>): void {
    this.inboundHandlers.push(handler)
  }

  async sendMessage(msg: OutboundMessage): Promise<SendResult> {
    const message: Message = {
      id: randomUUID(),
      role: 'assistant',
      text: msg.text,
      channel: 'desktop',
      createdAt: new Date().toISOString(),
    }
    this.broadcastToWorkspace(msg.chatId, { type: 'message', message })
    return {}
  }

  async streamMessage(msg: StreamableOutbound): Promise<SendResult> {
    const messageId = randomUUID()
    let lastText = ''
    for await (const text of msg.textStream) {
      lastText = text
      this.broadcastToWorkspace(msg.chatId, {
        type: 'message-delta',
        messageId,
        text,
      })
    }
    let resolved = msg.finalText ?? lastText
    if (msg.finalTextOverride) {
      try {
        const override = await Promise.race([
          msg.finalTextOverride,
          new Promise<string>((_, reject) =>
            setTimeout(
              () => reject(new Error('timeout')),
              FINAL_TEXT_OVERRIDE_TIMEOUT_MS,
            ),
          ),
        ])
        if (typeof override === 'string' && override.length > 0) resolved = override
      } catch {
        // keep last/finalText fallback
      }
    }
    this.broadcastToWorkspace(msg.chatId, {
      type: 'message-final',
      messageId,
      text: resolved,
    })
    return {}
  }

  /** Used by OutboundDispatcher to forward messages from other channels. */
  async mirror(workspaceId: string, message: Message): Promise<void> {
    this.broadcastToWorkspace(workspaceId, {
      type: 'message-from-other-channel',
      message,
    })
  }

  /** Entry point: caller wires `server.on('upgrade', adapter.handleUpgrade.bind(adapter))` */
  handleUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname !== '/ws/chat') {
      socket.destroy()
      return
    }

    const rawAuth = req.headers['authorization']
    const auth = Array.isArray(rawAuth) ? rawAuth[0] : (rawAuth ?? '')
    const m = /^Bearer\s+(.+)$/i.exec(auth)
    const token = m?.[1] ?? url.searchParams.get('token') ?? ''
    const payload = token ? this.deps.verifyJwt(token) : null

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (!payload) {
        ws.close(4001, 'auth_failed')
        return
      }
      this.wss.emit('connection', ws, req, payload.sub)
    })
  }

  /** For tests + diagnostics. */
  connectionsFor(workspaceId: string): number {
    let n = 0
    for (const c of this.connections) if (c.workspaceId === workspaceId) n++
    return n
  }

  private broadcastToWorkspace(workspaceId: string, frame: ServerMessage): void {
    const payload = JSON.stringify(frame)
    for (const c of this.connections) {
      if (c.workspaceId !== workspaceId) continue
      if (c.socket.readyState === c.socket.OPEN) {
        try {
          c.socket.send(payload)
        } catch {
          // peer gone, will close shortly
        }
      }
    }
  }

  private safeSend(socket: WS, frame: ServerMessage): void {
    if (socket.readyState !== socket.OPEN) return
    try {
      socket.send(JSON.stringify(frame))
    } catch {
      // ignore
    }
  }
}
