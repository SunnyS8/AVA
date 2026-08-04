import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'

export interface MockBackend {
  url: string
  close: () => Promise<void>
  /** Simulate user clicking /start in Telegram. */
  simulateTelegramStart: () => void
}

export interface MockBackendOptions {
  /** Enable the /ws/chat WebSocket endpoint with a canned streaming reply. */
  enableChatWs?: boolean
}

const FAKE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

interface MockState {
  pendingNonce: string | null
  completedJwt: string | null
}

export async function startMockBackend(opts: MockBackendOptions = {}): Promise<MockBackend> {
  const state: MockState = { pendingNonce: null, completedJwt: null }

  let server: Server
  // eslint-disable-next-line prefer-const
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x')
    if (req.method === 'GET' && url.pathname === '/catalog/personas') {
      const port = (server.address() as AddressInfo).port
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify([
          {
            id: 'betsy-default',
            name: 'Бетси',
            gender: 'female',
            voiceId: 'A',
            defaultBehavior: { voice: 'auto', selfie: 'auto', video: 'auto' },
            biography: 'Тёплый помощник',
            defaultPersonalityPrompt: 'pp',
            avatar: { static: `http://localhost:${port}/fake-avatar.png` },
            wizardLines: {
              mode_intro: 'mode_intro_line',
              mode_selfhost_checklist: ['VPS', 'SSH'],
              mode_selfhost_hint: 'hint',
              tg_login_intro: 'login_intro_line',
              tg_login_waiting: 'wait_line',
              tg_login_success: 'ok',
              ssh_prompt: 'ssh',
              ssh_test_ok: 'ok',
              install_progress: 'progress',
              install_done: 'done',
              bot_token_prompt: 'token',
              bot_webhook_ok: 'ok',
              wizard_complete: 'complete_line',
            },
          },
        ]),
      )
      return
    }
    if (req.method === 'GET' && url.pathname === '/fake-avatar.png') {
      res.setHeader('content-type', 'image/png')
      res.end(FAKE_PNG)
      return
    }
    if (req.method === 'POST' && url.pathname === '/auth/tg-link/start') {
      state.pendingNonce = 'test-nonce-' + Date.now()
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          nonce: state.pendingNonce,
          deepLink: `https://t.me/x?start=${state.pendingNonce}`,
          expiresIn: 300,
        }),
      )
      return
    }
    if (req.method === 'GET' && url.pathname === '/auth/tg-link/poll') {
      // Long-poll: wait up to maxWaitMs for completion, or return 408
      const maxWaitMs = Math.min(Number(url.searchParams.get('maxWaitMs') ?? '30000'), 30000)
      const start = Date.now()
      const tick = (): void => {
        if (state.completedJwt) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ jwt: state.completedJwt, workspaceId: 'ws-mock' }))
          return
        }
        if (Date.now() - start >= maxWaitMs) {
          res.statusCode = 408
          res.end('{}')
          return
        }
        setTimeout(tick, 50)
      }
      tick()
      return
    }
    if (req.method === 'GET' && url.pathname === '/chat/history') {
      // Mock history is always empty for the happy path; the WS pushes
      // the initial history-batch frame on connect.
      const auth = req.headers.authorization ?? ''
      if (!auth.startsWith('Bearer ')) {
        res.statusCode = 401
        res.end('{}')
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ messages: [], hasMore: false }))
      return
    }
    res.statusCode = 404
    res.end()
  })

  // WS chat — only attached if requested. The handler accepts every JWT
  // (it just checks for presence of an Authorization header) and replies
  // with a canned streamed message for any user-message frame.
  let wss: WebSocketServer | null = null
  if (opts.enableChatWs) {
    wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname !== '/ws/chat') {
        socket.destroy()
        return
      }
      wss!.handleUpgrade(req, socket, head, (ws) => {
        // Push an empty history-batch immediately so the renderer's
        // useChat treats the connection as ready.
        ws.send(JSON.stringify({ type: 'history-batch', messages: [], hasMore: false }))
        ws.on('message', (raw) => {
          let msg: { type?: string; text?: string; clientMessageId?: string }
          try {
            msg = JSON.parse(raw.toString())
          } catch {
            return
          }
          if (msg.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }))
            return
          }
          if (msg.type === 'user-message') {
            const messageId = 'm-' + Date.now()
            const chunks = ['ок', 'окей', 'окей, понял.']
            void (async () => {
              for (const c of chunks) {
                await new Promise((r) => setTimeout(r, 30))
                ws.send(JSON.stringify({ type: 'message-delta', messageId, text: c }))
              }
              ws.send(
                JSON.stringify({ type: 'message-final', messageId, text: 'окей, понял.' }),
              )
            })()
          }
        })
      })
    })
  }

  await new Promise<void>((r) => {
    server.listen(0, () => r())
  })
  const port = (server.address() as AddressInfo).port

  return {
    url: `http://localhost:${port}`,
    close: () =>
      new Promise((r) => {
        wss?.close()
        server.close(() => r())
      }),
    simulateTelegramStart: () => {
      state.completedJwt = 'mock-jwt'
    },
  }
}
