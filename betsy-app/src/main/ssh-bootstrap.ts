import { Client, type ConnectConfig } from 'ssh2'
import { EventEmitter } from 'node:events'
import { generateEnv, type EnvParams } from './docker-compose-template'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SshCreds {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
}

export interface CheckResult {
  os: string
  hasDocker: boolean
  hasCompose: boolean
  diskFreeGb: number
  warnings: string[]
}

export interface DeployResult {
  env: Record<string, string>
  jwtSecret: string
  dbPassword: string
}

export class SshBootstrap extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = new Client()
  private connected = false

  constructor(
    private creds: SshCreds,
    private resourcesDir: string,
  ) {
    super()
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const config: ConnectConfig = {
        host: this.creds.host,
        port: this.creds.port,
        username: this.creds.username,
      }
      if (this.creds.password) config.password = this.creds.password
      if (this.creds.privateKey) config.privateKey = this.creds.privateKey

      this.client.on('ready', () => {
        this.connected = true
        resolve()
      })
      this.client.on('error', (e: Error) => reject(e))
      this.client.connect(config)
    })
  }

  disconnect(): void {
    if (this.connected) this.client.end()
    this.connected = false
  }

  async exec(
    cmd: string,
    opts: { stream?: boolean } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.client.exec(cmd, (err: Error | undefined, stream: any) => {
        if (err) return reject(err)
        let out = ''
        let errOut = ''
        stream.on('data', (d: Buffer) => {
          const s = d.toString()
          out += s
          if (opts.stream) this.emit('stdout', s)
        })
        stream.stderr.on('data', (d: Buffer) => {
          const s = d.toString()
          errOut += s
          if (opts.stream) this.emit('stderr', s)
        })
        stream.on('close', (code: number) => resolve({ code, stdout: out, stderr: errOut }))
      })
    })
  }

  async runChecks(): Promise<CheckResult> {
    const warnings: string[] = []
    const uname = await this.exec('uname -a')
    if (!uname.stdout.toLowerCase().includes('linux')) warnings.push('not-linux')

    const docker = await this.exec('docker --version || echo NO_DOCKER')
    const hasDocker = !docker.stdout.includes('NO_DOCKER')

    const compose = await this.exec('docker compose version || echo NO_COMPOSE')
    const hasCompose = !compose.stdout.includes('NO_COMPOSE')

    const df = await this.exec(`df -BG --output=avail / | tail -1`)
    const diskFreeGb = parseInt(df.stdout.trim().replace('G', ''), 10) || 0
    if (diskFreeGb < 10) warnings.push('low-disk')

    return {
      os: uname.stdout.trim(),
      hasDocker,
      hasCompose,
      diskFreeGb,
      warnings,
    }
  }

  async installDockerIfMissing(): Promise<void> {
    const check = await this.runChecks()
    if (check.hasDocker && check.hasCompose) return
    this.emit('progress', { pct: 5, log: 'Устанавливаю Docker...' })
    const inst = await this.exec(`curl -fsSL https://get.docker.com | sh`, { stream: true })
    if (inst.code !== 0) throw new Error(`docker install failed: ${inst.stderr}`)
  }

  async deploy(params: EnvParams): Promise<DeployResult> {
    await this.installDockerIfMissing()
    this.emit('progress', { pct: 15, log: 'Создаю /opt/betsy-multi' })
    await this.exec(`mkdir -p /opt/betsy-multi`)

    const tpl = readFileSync(join(this.resourcesDir, 'docker-compose.template.yml'), 'utf-8')
    const gen = generateEnv(params)

    this.emit('progress', { pct: 20, log: 'Заливаю compose-файл' })
    await this.writeRemote('/opt/betsy-multi/docker-compose.yml', tpl)
    await this.writeRemote('/opt/betsy-multi/.env', gen.asEnvFile)

    this.emit('progress', { pct: 30, log: 'docker compose pull...' })
    const pull = await this.exec(`cd /opt/betsy-multi && docker compose pull`, { stream: true })
    if (pull.code !== 0) throw new Error(`pull failed: ${pull.stderr}`)

    this.emit('progress', { pct: 75, log: 'docker compose up -d' })
    const up = await this.exec(`cd /opt/betsy-multi && docker compose up -d`, { stream: true })
    if (up.code !== 0) throw new Error(`up failed: ${up.stderr}`)

    this.emit('progress', { pct: 85, log: 'Ожидаю /healthz...' })
    const ok = await this.waitForHealth(params.publicUrl, 120_000)
    if (!ok) throw new Error('engine did not become healthy in 120s')

    this.emit('progress', { pct: 100, log: 'Готово' })
    return gen
  }

  private async waitForHealth(publicUrl: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const r = await this.exec(`curl -sf ${publicUrl}/healthz`)
      if (r.code === 0) return true
      await new Promise((res) => setTimeout(res, 2000))
    }
    return false
  }

  private writeRemote(path: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.client.sftp((err: Error | undefined, sftp: any) => {
        if (err) return reject(err)
        const stream = sftp.createWriteStream(path)
        stream.on('close', () => resolve())
        stream.on('error', reject)
        stream.end(content)
      })
    })
  }

  private readRemote(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.client.sftp((err: Error | undefined, sftp: any) => {
        if (err) return reject(err)
        const stream = sftp.createReadStream(path)
        const chunks: Buffer[] = []
        stream.on('data', (d: Buffer) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
        stream.on('error', (e: Error) => reject(e))
      })
    })
  }

  /**
   * Patch a single KEY=VALUE line in /opt/betsy-multi/.env via SFTP (NOT
   * shell sed — the user-supplied value would be interpolated into a sed
   * command, which is a shell-injection sink). Throws if the key is missing
   * because that means the wizard's deploy step didn't write the .env we
   * expect — surfacing rather than silently appending keeps the contract
   * tight.
   */
  private async patchEnvLine(key: string, value: string): Promise<void> {
    const current = await this.readRemote('/opt/betsy-multi/.env')
    const lineRe = new RegExp(`^${key}=.*$`, 'm')
    if (!lineRe.test(current)) {
      throw new Error(`.env does not contain ${key} line`)
    }
    const updated = current.replace(lineRe, `${key}=${value}`)
    await this.writeRemote('/opt/betsy-multi/.env', updated)
  }

  async setBotWebhook(botToken: string): Promise<void> {
    // Defense in depth: validate shape even though the SFTP path is
    // injection-safe. Legitimate Telegram tokens are `\d+:[A-Za-z0-9_-]{30,}`.
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
      throw new Error('invalid bot token format')
    }
    await this.patchEnvLine('BC_TELEGRAM_BOT_TOKEN', botToken)
    const restart = await this.exec(`cd /opt/betsy-multi && docker compose restart betsy`)
    if (restart.code !== 0) throw new Error(`restart failed: ${restart.stderr}`)
  }

  /**
   * Update GEMINI_API_KEY in the deployed .env and restart the engine.
   * Called from BotTokenForm so the user can supply the key without
   * SSH-ing in. The wizard treats this as best-effort: if the user skips
   * the field, the engine fails loud on boot.
   */
  async setEngineEnv(params: { geminiApiKey: string }): Promise<void> {
    // Disallow newlines / control chars so the value can't escape the line.
    // Allow empty string explicitly — caller may want to clear the key.
    if (/[\r\n]/.test(params.geminiApiKey)) {
      throw new Error('invalid Gemini API key: contains newline')
    }
    await this.patchEnvLine('GEMINI_API_KEY', params.geminiApiKey)
    const restart = await this.exec(`cd /opt/betsy-multi && docker compose restart betsy`)
    if (restart.code !== 0) throw new Error(`restart failed: ${restart.stderr}`)
  }

  async updateEngine(): Promise<void> {
    this.emit('progress', { pct: 0, log: 'Pulling new image...' })
    const pull = await this.exec(`cd /opt/betsy-multi && docker compose pull`, { stream: true })
    if (pull.code !== 0) throw new Error(`update pull failed: ${pull.stderr}`)
    this.emit('progress', { pct: 80, log: 'Restarting...' })
    const up = await this.exec(`cd /opt/betsy-multi && docker compose up -d`, { stream: true })
    if (up.code !== 0) throw new Error(`update up failed: ${up.stderr}`)
    this.emit('progress', { pct: 100, log: 'Готово' })
  }
}
