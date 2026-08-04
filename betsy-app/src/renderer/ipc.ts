import type { IpcContract } from '../shared/ipc-contract'

declare global {
  interface Window {
    api: {
      invoke<C extends keyof IpcContract>(
        channel: C,
        ...args: Parameters<IpcContract[C]>
      ): ReturnType<IpcContract[C]>
      on(channel: string, cb: (data: unknown) => void): () => void
    }
  }
}

export const api = window.api
