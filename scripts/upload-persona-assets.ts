/**
 * upload-persona-assets.ts — seed Cloudflare R2 with persona avatar assets.
 *
 * For every directory under `assets/presets/<id>/`, every file is uploaded to
 *   s3://betsy-cdn/presets/<id>/<file>
 * which is publicly served at https://cdn.betsyai.io/presets/<id>/<file>.
 *
 * Usage:
 *   R2_ACCOUNT_ID=... \
 *   R2_ACCESS_KEY_ID=... \
 *   R2_SECRET_ACCESS_KEY=... \
 *   npx tsx scripts/upload-persona-assets.ts
 *
 * Optional env:
 *   R2_BUCKET                — default "betsy-cdn"
 *   PERSONA_ASSETS_DIR       — default "assets/presets"
 *   DRY_RUN=1                — list intended uploads and exit
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'

interface UploadPlanItem {
  localPath: string
  key: string
  contentType: string
  size: number
}

function contentTypeFor(file: string): string {
  const ext = extname(file).toLowerCase()
  switch (ext) {
    case '.webp':
      return 'image/webp'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.svg':
      return 'image/svg+xml'
    case '.mp3':
      return 'audio/mpeg'
    case '.wav':
      return 'audio/wav'
    case '.ogg':
      return 'audio/ogg'
    case '.mp4':
      return 'video/mp4'
    case '.webm':
      return 'video/webm'
    case '.json':
      return 'application/json'
    default:
      return 'application/octet-stream'
  }
}

function buildPlan(root: string): UploadPlanItem[] {
  if (!existsSync(root)) {
    throw new Error(`PERSONA_ASSETS_DIR not found: ${root}`)
  }
  const plan: UploadPlanItem[] = []
  for (const entry of readdirSync(root)) {
    const presetDir = join(root, entry)
    const dirStat = statSync(presetDir)
    if (!dirStat.isDirectory()) continue
    for (const file of readdirSync(presetDir)) {
      const local = join(presetDir, file)
      const fileStat = statSync(local)
      if (!fileStat.isFile()) continue
      plan.push({
        localPath: local,
        key: `presets/${entry}/${file}`,
        contentType: contentTypeFor(file),
        size: fileStat.size,
      })
    }
  }
  return plan
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}

async function main(): Promise<void> {
  const root = process.env.PERSONA_ASSETS_DIR ?? 'assets/presets'
  const bucket = process.env.R2_BUCKET ?? 'betsy-cdn'
  const dryRun = process.env.DRY_RUN === '1'

  const plan = buildPlan(root)
  if (plan.length === 0) {
    console.warn(`[upload-persona-assets] nothing to upload under ${root}`)
    return
  }

  console.log(`[upload-persona-assets] ${plan.length} file(s) planned for bucket "${bucket}":`)
  for (const item of plan) {
    console.log(`  ${item.localPath} -> s3://${bucket}/${item.key} (${item.contentType}, ${item.size} B)`)
  }

  if (dryRun) {
    console.log('[upload-persona-assets] DRY_RUN=1 — exiting without uploading.')
    return
  }

  const accountId = requireEnv('R2_ACCOUNT_ID')
  const accessKeyId = requireEnv('R2_ACCESS_KEY_ID')
  const secretAccessKey = requireEnv('R2_SECRET_ACCESS_KEY')

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  })

  let failures = 0
  for (const item of plan) {
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: item.key,
          Body: readFileSync(item.localPath),
          ContentType: item.contentType,
          CacheControl: 'public, max-age=86400',
        }),
      )
      console.log(`  uploaded ${item.key}`)
    } catch (err) {
      failures++
      console.error(`  FAILED ${item.key}:`, err instanceof Error ? err.message : err)
    }
  }

  if (failures > 0) {
    console.error(`[upload-persona-assets] ${failures} upload(s) failed`)
    process.exit(1)
  }
  console.log('[upload-persona-assets] done')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err)
  process.exit(1)
})
