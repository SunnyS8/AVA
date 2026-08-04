import type { Message } from '../shared/chat-protocol'

export interface HistoryResponse {
  messages: Message[]
  hasMore: boolean
}

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

/**
 * REST client for GET /chat/history. Cursor pagination via `before=<messageId>`.
 *
 * Used by the main process to expose `chat:history` IPC to the renderer.
 */
export class ChatHistoryClient {
  constructor(
    private apiBase: string,
    private jwt: string,
    private fetchFn: FetchLike = fetch as unknown as FetchLike,
  ) {}

  async fetchHistory(opts: { before?: string; limit?: number } = {}): Promise<HistoryResponse> {
    const params: string[] = []
    if (opts.before) params.push(`before=${encodeURIComponent(opts.before)}`)
    if (opts.limit) params.push(`limit=${encodeURIComponent(String(opts.limit))}`)
    const qs = params.length > 0 ? `?${params.join('&')}` : ''
    const url = `${this.apiBase}/chat/history${qs}`
    const res = await this.fetchFn(url, {
      headers: { authorization: `Bearer ${this.jwt}` },
    })
    if (res.status === 401) throw new Error('auth_failed')
    if (!res.ok) throw new Error(`history fetch failed: ${res.status}`)
    return (await res.json()) as HistoryResponse
  }
}
