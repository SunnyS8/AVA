import Database from 'better-sqlite3'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface CachedPreset {
  id: string
  name: string
  gender: string | null
  voiceId: string
  defaultBehavior: unknown
  biography: string
  defaultPersonalityPrompt: string
  avatar: { static: string; voiceSample?: string }
  wizardLines: Record<string, string | string[]>
}

export type FetchFn = (url: string, init?: unknown) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  arrayBuffer?: () => Promise<ArrayBuffer>
  headers?: { get: (k: string) => string | null }
}>

export class PersonaCache {
  private db: Database.Database
  private blobDir: string

  constructor(
    private dir: string,
    private apiBase: string,
    private fetchFn: FetchFn = fetch as unknown as FetchFn,
  ) {
    mkdirSync(dir, { recursive: true })
    this.db = new Database(join(dir, 'persona-cache.db'))
    this.db.exec(`
      create table if not exists presets (
        id text primary key,
        json text not null,
        avatar_blob_path text,
        updated_at integer not null
      );
    `)
    this.blobDir = join(dir, 'blobs')
    mkdirSync(this.blobDir, { recursive: true })
  }

  async refresh(): Promise<void> {
    const res = await this.fetchFn(`${this.apiBase}/catalog/personas`)
    if (!res.ok) throw new Error(`catalog fetch failed: ${res.status}`)
    const presets = (await res.json()) as CachedPreset[]

    const upsert = this.db.prepare(`
      insert into presets (id, json, avatar_blob_path, updated_at)
      values (?, ?, ?, ?)
      on conflict(id) do update set json = excluded.json, avatar_blob_path = excluded.avatar_blob_path, updated_at = excluded.updated_at
    `)

    for (const p of presets) {
      let blobPath: string | null = null
      try {
        const r = await this.fetchFn(p.avatar.static)
        if (r.ok && r.arrayBuffer) {
          const buf = Buffer.from(await r.arrayBuffer())
          blobPath = join(this.blobDir, `${p.id}-avatar.bin`)
          writeFileSync(blobPath, buf)
        }
      } catch {
        // avatar fetch failure is non-fatal — wizard still works with no avatar
      }
      upsert.run(p.id, JSON.stringify(p), blobPath, Date.now())
    }

    // remove presets no longer in catalog
    const ids = presets.map((p) => p.id)
    if (ids.length > 0) {
      this.db
        .prepare(`delete from presets where id not in (${ids.map(() => '?').join(',')})`)
        .run(...ids)
    } else {
      this.db.prepare('delete from presets').run()
    }
  }

  async list(): Promise<CachedPreset[]> {
    const rows = this.db.prepare('select json from presets order by id').all() as {
      json: string
    }[]
    return rows.map((r) => JSON.parse(r.json) as CachedPreset)
  }

  async get(id: string): Promise<CachedPreset | null> {
    const row = this.db.prepare('select json from presets where id = ?').get(id) as
      | { json: string }
      | undefined
    return row ? (JSON.parse(row.json) as CachedPreset) : null
  }

  async getAvatarPath(id: string): Promise<string | null> {
    const row = this.db.prepare('select avatar_blob_path from presets where id = ?').get(id) as
      | { avatar_blob_path: string | null }
      | undefined
    if (row?.avatar_blob_path && existsSync(row.avatar_blob_path)) return row.avatar_blob_path
    return null
  }

  hasAny(): boolean {
    const row = this.db.prepare('select count(*) as c from presets').get() as { c: number }
    return row.c > 0
  }

  close(): void {
    this.db.close()
  }
}
