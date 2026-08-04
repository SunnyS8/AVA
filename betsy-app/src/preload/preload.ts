import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: string, cb: (data: unknown) => void) => {
    const listener = (_e: unknown, data: unknown): void => cb(data)
    ipcRenderer.on(channel, listener)
    return (): void => {
      ipcRenderer.off(channel, listener)
    }
  },
})
