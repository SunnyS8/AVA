import WebSocket from 'ws'
import { EventEmitter } from 'node:events'
import type { ClientMessage, ServerMessage } from '../shared/chat-protocol'

export interface BackendConnectorOptions {
  url: string // wss://api.betsyai.io/ws/chat
  jwt: string
  backoffStartMs?: number // default 1000
  backoffMaxMs?: number // default 30000
  pingIntervalMs?: number // default 30000
}

/**
 * Persistent WS to the multi-server. Auto-reconnect with exponential backoff.
 *
 * Emits:
 *   - 'open'           when connected (or reconnected)
 *   - 'message'        (data: ServerMessage)   for any server frame
 *   - 'close'          on socket close (will reconnect unless auth-failed)
 *   - 'auth-failed'    on close 4001 — stops reconnecting; renderer should re-auth
 */
export class BackendConnector extends EventEmitter {
  private ws: WebSocket | null = null
  private alive = false
  private authFailed = false
  private currentBackoff: number
  private readonly maxBackoff: number
  private readonly pingInterval: number
  private pingTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null

  constructor(private options: BackendConnectorOptions) {
    super()
    this.currentBackoff = options.backoffStartMs ?? 1000
    this.maxBackoff = options.backoffMaxMs ?? 30_000
    this.pingInterval = options.pingIntervalMs ?? 30_000
  }

  start(): void {
    this.alive = true
    this.authFailed = false
    this.currentBackoff = this.options.backoffStartMs ?? 1000
    this.connect()
  }

  stop(): void {
    this.alive = false
    this.stopPing()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close(1000, 'client-stop')
      } catch {
        // swallow
      }
    }
    this.ws = null
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  private connect(): void {
    if (this.authFailed || !this.alive) return
    const ws = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${this.options.jwt}` },
    })
    this.ws = ws
    ws.on('open', () => {
      // Reset backoff after a successful connect.
      this.currentBackoff = this.options.backoffStartMs ?? 1000
      this.emit('open')
      this.startPing()
    })
    ws.on('message', (raw) => {
      let parsed: ServerMessage
      try {
        parsed = JSON.parse(raw.toString()) as ServerMessage
      } catch {
        return
      }
      this.emit('message', parsed)
    })
    ws.on('close', (code: number) => {
      this.stopPing()
      this.ws = null
      this.emit('close', code)
      if (code === 4001) {
        this.authFailed = true
        this.emit('auth-failed')
        return
      }
      if (this.alive) {
        const delay = this.currentBackoff
        this.currentBackoff = Math.min(this.currentBackoff * 2, this.maxBackoff)
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          this.connect()
        }, delay)
      }
    })
    ws.on('error', () => {
      // covered by 'close'; swallow to keep listener semantics quiet
    })
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' })
      }
    }, this.pingInterval)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }
}
