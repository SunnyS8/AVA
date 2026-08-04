import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'

/**
 * Minimal smoke against the published staging API. Gated on BC_LIVE_TEST_URL
 * so CI / local runs without a target backend silently skip.
 */
describe.skipIf(!process.env.BC_LIVE_TEST_URL)('desktop WS live wire', () => {
  it('rejects connection without JWT', async () => {
    const url = process.env.BC_LIVE_TEST_URL!.replace(/^http/, 'ws') + '/ws/chat'
    const ws = new WebSocket(url)
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c))
      ws.on('error', () => resolve(-1))
    })
    expect(code === 4001 || code === -1).toBe(true)
  })
})
