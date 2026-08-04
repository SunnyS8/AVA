export type FetchLikeResponse = {
  ok: boolean
  status: number
  json: () => Promise<unknown>
}

export type FetchLikeFn = (url: string, init?: unknown) => Promise<FetchLikeResponse>

export type PollResult =
  | { kind: 'completed'; jwt: string; workspaceId: string }
  | { kind: 'timeout' }
  | { kind: 'expired' }
  | { kind: 'error'; status: number; message: string }

export class HostedAuth {
  constructor(
    private apiBase: string,
    private fetchFn: FetchLikeFn = fetch as unknown as FetchLikeFn,
  ) {}

  async start(presetId: string): Promise<{ nonce: string; deepLink: string; expiresIn: number }> {
    const res = await this.fetchFn(`${this.apiBase}/auth/tg-link/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetId }),
    })
    if (!res.ok) throw new Error(`start failed: ${res.status}`)
    return (await res.json()) as { nonce: string; deepLink: string; expiresIn: number }
  }

  /** One long-poll round. Caller can loop. */
  async poll(nonce: string, maxWaitMs = 30_000): Promise<PollResult> {
    const res = await this.fetchFn(
      `${this.apiBase}/auth/tg-link/poll?nonce=${encodeURIComponent(nonce)}&maxWaitMs=${maxWaitMs}`,
    )
    if (res.status === 200) {
      const b = (await res.json()) as { jwt: string; workspaceId: string }
      return { kind: 'completed', jwt: b.jwt, workspaceId: b.workspaceId }
    }
    if (res.status === 404) return { kind: 'expired' }
    if (res.status === 408) return { kind: 'timeout' }
    return { kind: 'error', status: res.status, message: 'unexpected' }
  }
}
