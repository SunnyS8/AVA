import { ipcMain } from 'electron'
import type { IpcContract } from '../shared/ipc-contract'

export type { IpcContract, SshCredsDto, DeployParamsDto, AppInfo } from '../shared/ipc-contract'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handlers = Partial<{ [K in keyof IpcContract]: (...args: any[]) => any }>

export function registerIpcHandlers(handlers: Handlers): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    if (!handler) continue
    ipcMain.handle(channel, async (_e, ...args) => handler(...args))
  }
}
