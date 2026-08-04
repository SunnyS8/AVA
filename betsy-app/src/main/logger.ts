import { app } from 'electron'
import { mkdirSync, appendFileSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'

const MAX_SIZE = 5 * 1024 * 1024
let logFile: string | null = null

function getLogFile(): string | null {
  if (logFile) return logFile
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, 'betsy-app.log')
    return logFile
  } catch {
    return null
  }
}

function rotate(path: string): void {
  try {
    const s = statSync(path)
    if (s.size > MAX_SIZE) renameSync(path, path + '.1')
  } catch {
    // file doesn't exist yet — no rotation needed
  }
}

export function log(level: 'info' | 'warn' | 'error', msg: string, meta?: object): void {
  const path = getLogFile()
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...meta }) + '\n'
  if (path) {
    rotate(path)
    try {
      appendFileSync(path, line)
    } catch {
      // best-effort logging
    }
  }
  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console[level](msg, meta ?? '')
  }
}
