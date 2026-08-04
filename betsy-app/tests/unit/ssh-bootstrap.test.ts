import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import type { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let resourcesDir: string

beforeAll(() => {
  resourcesDir = mkdtempSync(join(tmpdir(), 'ssh-bootstrap-'))
  writeFileSync(join(resourcesDir, 'docker-compose.template.yml'), 'version: 3.9\n')
})

afterAll(() => {
  rmSync(resourcesDir, { recursive: true, force: true })
})

// A simple in-memory remote FS shared across all FakeClient instances in
// the test file. Tests reset it in beforeEach via setRemoteFile().
const remoteFs = new Map<string, string>()

vi.mock('ssh2', async () => {
  const { EventEmitter: EE } = await import('node:events')
  class FakeStream extends EE {
    stderr = new EE()
    end(): void {
      // no-op
    }
  }
  type Match = { cmd: string; stdout: string; stderr: string; code: number }
  class FakeClient extends EE {
    private _cmds: Match[] = []
    setMockExec(matches: Match[]): void {
      this._cmds = matches
    }
    connect(): void {
      setImmediate(() => this.emit('ready'))
    }
    end(): void {
      // no-op
    }
    exec(cmd: string, cb: (err: Error | null, stream: FakeStream) => void): void {
      const match = this._cmds.find((m) => cmd.includes(m.cmd))
      const stream = new FakeStream()
      cb(null, stream)
      setImmediate(() => {
        if (match) {
          if (match.stdout) stream.emit('data', Buffer.from(match.stdout))
          if (match.stderr) stream.stderr.emit('data', Buffer.from(match.stderr))
          stream.emit('close', match.code)
        } else {
          stream.emit('close', 0)
        }
      })
    }
    sftp(
      cb: (
        err: Error | null,
        sftp: {
          createWriteStream: (path: string) => EventEmitter & { end: (data: string) => void }
          createReadStream: (path: string) => EventEmitter
        },
      ) => void,
    ): void {
      cb(null, {
        createWriteStream: (path: string) => {
          const s = new EE() as EventEmitter & { end: (data: string) => void }
          s.end = (data: string): void => {
            remoteFs.set(path, data)
            setImmediate(() => s.emit('close'))
          }
          return s
        },
        createReadStream: (path: string) => {
          const s = new EE()
          setImmediate(() => {
            const content = remoteFs.get(path)
            if (content === undefined) {
              s.emit('error', new Error(`ENOENT: ${path}`))
              return
            }
            s.emit('data', Buffer.from(content))
            s.emit('end')
          })
          return s
        },
      })
    }
  }
  return { Client: FakeClient }
})

import { SshBootstrap } from '../../src/main/ssh-bootstrap'

describe('SshBootstrap', () => {
  let bootstrap: SshBootstrap
  beforeEach(() => {
    remoteFs.clear()
    bootstrap = new SshBootstrap(
      { host: 'h', port: 22, username: 'u', password: 'p' },
      resourcesDir,
    )
  })

  it('connect() resolves on ready', async () => {
    await expect(bootstrap.connect()).resolves.toBeUndefined()
  })

  it('runChecks() returns hasDocker=true when docker present', async () => {
    await bootstrap.connect()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(bootstrap as any).client.setMockExec([
      { cmd: 'uname -a', stdout: 'Linux ubuntu 6.0\n', stderr: '', code: 0 },
      { cmd: 'docker --version', stdout: 'Docker version 24.0\n', stderr: '', code: 0 },
      { cmd: 'docker compose version', stdout: 'compose v2\n', stderr: '', code: 0 },
      { cmd: 'df -BG', stdout: '  50G\n', stderr: '', code: 0 },
    ])
    const c = await bootstrap.runChecks()
    expect(c.hasDocker).toBe(true)
    expect(c.hasCompose).toBe(true)
    expect(c.diskFreeGb).toBeGreaterThanOrEqual(40)
    expect(c.warnings).not.toContain('low-disk')
  })

  it('runChecks() warns on low disk', async () => {
    await bootstrap.connect()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(bootstrap as any).client.setMockExec([
      { cmd: 'uname -a', stdout: 'Linux\n', stderr: '', code: 0 },
      { cmd: 'docker --version', stdout: 'Docker\n', stderr: '', code: 0 },
      { cmd: 'docker compose version', stdout: 'v2\n', stderr: '', code: 0 },
      { cmd: 'df -BG', stdout: '  3G\n', stderr: '', code: 0 },
    ])
    const c = await bootstrap.runChecks()
    expect(c.warnings).toContain('low-disk')
  })

  it('emits progress events during deploy', async () => {
    await bootstrap.connect()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(bootstrap as any).client.setMockExec([
      { cmd: 'uname -a', stdout: 'Linux\n', stderr: '', code: 0 },
      { cmd: 'docker --version', stdout: 'v24\n', stderr: '', code: 0 },
      { cmd: 'docker compose version', stdout: 'v2\n', stderr: '', code: 0 },
      { cmd: 'df -BG', stdout: '  50G\n', stderr: '', code: 0 },
      { cmd: 'curl -sf', stdout: 'ok', stderr: '', code: 0 },
    ])

    const events: { pct: number }[] = []
    bootstrap.on('progress', (e: { pct: number }) => events.push(e))
    await bootstrap.deploy({ presetId: 'betsy-default', publicUrl: 'http://1.2.3.4:3777' })
    const pcts = events.map((e) => e.pct)
    expect(pcts).toContain(15)
    expect(pcts).toContain(30)
    expect(pcts).toContain(100)
  })

  describe('setBotWebhook', () => {
    const VALID_TOKEN = '123456789:AAFakeFakeFakeFakeFakeFakeFakeFakeFake'

    it('rejects malformed tokens without touching the remote', async () => {
      await bootstrap.connect()
      remoteFs.set('/opt/betsy-multi/.env', 'BC_TELEGRAM_BOT_TOKEN=\n')
      await expect(bootstrap.setBotWebhook('not-a-token')).rejects.toThrow(
        /invalid bot token format/,
      )
      // Ensure remote file wasn't mutated.
      expect(remoteFs.get('/opt/betsy-multi/.env')).toBe('BC_TELEGRAM_BOT_TOKEN=\n')
    })

    it('patches the .env line via SFTP and restarts the service', async () => {
      await bootstrap.connect()
      remoteFs.set(
        '/opt/betsy-multi/.env',
        'BC_DB_PASSWORD=secret\nBC_TELEGRAM_BOT_TOKEN=\nGEMINI_API_KEY=\n',
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(bootstrap as any).client.setMockExec([
        { cmd: 'docker compose restart', stdout: '', stderr: '', code: 0 },
      ])
      await bootstrap.setBotWebhook(VALID_TOKEN)
      const env = remoteFs.get('/opt/betsy-multi/.env')!
      expect(env).toContain(`BC_TELEGRAM_BOT_TOKEN=${VALID_TOKEN}`)
      // Other lines untouched.
      expect(env).toContain('BC_DB_PASSWORD=secret')
      expect(env).toContain('GEMINI_API_KEY=')
    })

    it('errors when .env is missing the expected line (deploy was broken)', async () => {
      await bootstrap.connect()
      remoteFs.set('/opt/betsy-multi/.env', 'BC_DB_PASSWORD=secret\n')
      await expect(bootstrap.setBotWebhook(VALID_TOKEN)).rejects.toThrow(
        /does not contain BC_TELEGRAM_BOT_TOKEN/,
      )
    })

    it('does not interpolate token characters into a shell command (injection guard)', async () => {
      // Construct a malicious-but-shape-valid token: digits, colon,
      // 30+ chars from the safe alphabet. Then confirm it never lands in
      // any exec() call (it should go through SFTP only).
      await bootstrap.connect()
      remoteFs.set(
        '/opt/betsy-multi/.env',
        'BC_TELEGRAM_BOT_TOKEN=\n',
      )
      const execCalls: string[] = []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fakeClient = (bootstrap as any).client
      const origExec = fakeClient.exec.bind(fakeClient)
      fakeClient.exec = (cmd: string, cb: unknown): void => {
        execCalls.push(cmd)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return origExec(cmd, cb as any)
      }
      fakeClient.setMockExec([
        { cmd: 'docker compose restart', stdout: '', stderr: '', code: 0 },
      ])
      await bootstrap.setBotWebhook(VALID_TOKEN)
      for (const call of execCalls) {
        expect(call).not.toContain(VALID_TOKEN)
      }
    })
  })

  describe('setEngineEnv', () => {
    it('patches GEMINI_API_KEY via SFTP and restarts', async () => {
      await bootstrap.connect()
      remoteFs.set(
        '/opt/betsy-multi/.env',
        'BC_TELEGRAM_BOT_TOKEN=t\nGEMINI_API_KEY=\n',
      )
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(bootstrap as any).client.setMockExec([
        { cmd: 'docker compose restart', stdout: '', stderr: '', code: 0 },
      ])
      await bootstrap.setEngineEnv({ geminiApiKey: 'AIzaFake' })
      expect(remoteFs.get('/opt/betsy-multi/.env')).toContain('GEMINI_API_KEY=AIzaFake')
    })

    it('rejects newlines in the key', async () => {
      await bootstrap.connect()
      remoteFs.set('/opt/betsy-multi/.env', 'GEMINI_API_KEY=\n')
      await expect(
        bootstrap.setEngineEnv({ geminiApiKey: 'oops\nMORE=1' }),
      ).rejects.toThrow(/newline/)
    })
  })
})
