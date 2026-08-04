import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mock electron's safeStorage so the test can run outside an Electron host.
// Encryption is a trivial base64 round-trip — we only care about call shape,
// not real crypto.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string): Buffer => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer): string => b.toString('utf-8').replace(/^enc:/, ''),
  },
}))

import { SecureStorage } from '../../src/main/secure-storage'

function freshStore(): { storage: SecureStorage; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'secure-storage-'))
  const path = join(dir, 'secure.json')
  return { storage: new SecureStorage(path), path }
}

describe('SecureStorage', () => {
  let storage: SecureStorage
  let path: string

  beforeEach(() => {
    ;({ storage, path } = freshStore())
  })

  it('returns null for unknown key when file does not exist (ENOENT)', () => {
    expect(existsSync(path)).toBe(false)
    expect(storage.get('missing')).toBeNull()
  })

  it('round-trips a value through set/get', () => {
    storage.set('ssh', '{"host":"1.2.3.4"}')
    expect(storage.get('ssh')).toBe('{"host":"1.2.3.4"}')
  })

  it('uses atomic write-then-rename (no .tmp left behind on success)', () => {
    storage.set('k', 'v')
    expect(existsSync(path)).toBe(true)
    expect(existsSync(path + '.tmp')).toBe(false)
  })

  it('persists across instances (decoded base64 round-trip)', () => {
    storage.set('k', 'v')
    const other = new SecureStorage(path)
    expect(other.get('k')).toBe('v')
  })

  it('throws on corrupted JSON instead of silently nuking the store', () => {
    writeFileSync(path, '{not json')
    expect(() => storage.get('k')).toThrow(SyntaxError)
  })

  it('remove() deletes a single key and leaves others intact', () => {
    storage.set('a', '1')
    storage.set('b', '2')
    storage.remove('a')
    expect(storage.get('a')).toBeNull()
    expect(storage.get('b')).toBe('2')
  })

  it('set() overwrites the file atomically (json parses after write)', () => {
    storage.set('k', 'v')
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    expect(typeof parsed.k).toBe('string')
  })

  it('does not swallow non-ENOENT read errors', () => {
    // Simulate a non-ENOENT failure by making the path a directory so
    // readFileSync throws EISDIR (cross-platform).
    const { storage: s2, path: p2 } = freshStore()
    mkdirSync(p2)
    try {
      expect(() => s2.get('anything')).toThrow()
    } finally {
      try {
        rmdirSync(p2)
      } catch {
        // best-effort cleanup
      }
    }
  })
})
