import { safeStorage } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

export class SecureStorage {
  constructor(private filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
  }

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  set(key: string, value: string): void {
    if (!this.isAvailable()) throw new Error('encryption unavailable on this OS')
    const all = this.loadAll()
    all[key] = safeStorage.encryptString(value).toString('base64')
    this.atomicWrite(JSON.stringify(all))
  }

  get(key: string): string | null {
    const all = this.loadAll()
    const enc = all[key]
    if (!enc) return null
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  }

  remove(key: string): void {
    const all = this.loadAll()
    delete all[key]
    this.atomicWrite(JSON.stringify(all))
  }

  /**
   * write-to-tmp + rename so a crash mid-write can't truncate the live file
   * to zero bytes (which previously would nuke every saved credential).
   */
  private atomicWrite(content: string): void {
    const tmp = this.filePath + '.tmp'
    writeFileSync(tmp, content)
    renameSync(tmp, this.filePath)
  }

  private loadAll(): Record<string, string> {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch (e) {
      // Only an ENOENT counts as "no creds yet". Any other read error
      // (EACCES, EIO) is a real problem and we surface it instead of
      // returning {} — silently nuking the store on a transient disk
      // error is the exact data-loss pattern this rule guards against.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw e
    }
    // Parse failure means the file is corrupt — throw so the caller knows
    // their stored creds are unreadable instead of silently wiping them.
    return JSON.parse(raw) as Record<string, string>
  }
}
