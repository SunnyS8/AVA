# P1.C — Infrastructure & Shipping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the cloud-side hub that both deployment modes rely on — Docker registry for engine images, CDN for persona assets, update manifests for Electron shell + engine, public download page, GitHub Actions release pipeline, and EV code-signing procurement.

**Architecture:** Most "infra" here is configuration of GitHub + Cloudflare R2 + DNS — not application code. The two pieces that *are* code: a `release.yml` GitHub Actions workflow that builds and publishes both Electron installer and engine Docker image, and a tiny manifest-generator script. Everything is wired through `updates.betsyai.io` (R2 bucket behind Cloudflare proxy) and `ghcr.io/betsyai/betsy-multi` (GHCR).

**Tech Stack:** GitHub Actions, Docker, electron-builder (CLI from P1.B), Cloudflare R2 + DNS, EV Code Signing Certificate (DigiCert or Sectigo). Spec: [docs/superpowers/specs/2026-05-24-distribution-shell-p1-design.md](../specs/2026-05-24-distribution-shell-p1-design.md). Depends on P1.A endpoints (catalog) and P1.B build output (Electron installer).

---

## Pre-work — Manual procurement (do these BEFORE coding)

These steps require human action; they cannot be automated and gate later tasks. Track each as an "external" task in the project tracker.

- [ ] **External 1: Create Cloudflare R2 bucket `betsy-updates`**
  - In Cloudflare dashboard → R2 → Create bucket: `betsy-updates`
  - Public access: enabled with custom domain `updates.betsyai.io`
  - DNS: CNAME `updates.betsyai.io` → R2 public bucket endpoint
  - Save API token (read+write to bucket) as `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY`

- [ ] **External 2: Create Cloudflare R2 bucket `betsy-cdn` (for persona assets)**
  - Bucket: `betsy-cdn`, custom domain `cdn.betsyai.io`
  - Same R2 credentials reused or separate scoped token

- [ ] **External 3: Configure GitHub Container Registry**
  - Create org `betsyai` on GitHub (if not exists)
  - Create `betsy-multi` and `betsy-app` repositories (private until v1.0)
  - Personal Access Token with `write:packages` saved as `GHCR_TOKEN`

- [ ] **External 4: Purchase EV Code Signing Certificate**
  - Provider: DigiCert ($349/yr) or Sectigo ($319/yr) — pick on price/availability
  - **Identity validation takes 5-10 business days** — start ASAP, not blocking
  - Cert delivered as `.pfx` + password
  - Once received, save base64-encoded `.pfx` as GitHub Actions secret `WIN_CSC_LINK` and password as `WIN_CSC_KEY_PASSWORD`
  - **Until cert arrives**, ship with self-signed; smoke test that SmartScreen warning is the only friction (not a hard block)

- [ ] **External 5: Register `@betsyai_bot` on Telegram**
  - Chat with `@BotFather`, create bot `betsyai_bot`
  - Save token as GitHub Actions secret `BC_TG_BOT_TOKEN` (for hosted) and as env var on production server
  - Set bot description / about — minimal copy: "Бетси — твой AI-ассистент. Скачай Бетси для Windows: betsyai.io/download"

- [ ] **External 6: Reserve `betsyai.io/download` route**
  - DNS: `betsyai.io` → main marketing site (already exists per memory `reference_domain.md`)
  - Add a static page at `/download` (Task 5 below) that links to `updates.betsyai.io/electron/win-x64/Betsy-Setup-latest.exe`

---

## Task 1: Engine Docker image build + push to GHCR

**Files:**
- Create: `Dockerfile.multi` (at repo root) — produces `betsyai/betsy-multi` image
- Create: `.github/workflows/release-engine.yml`
- Test: manual `docker build` smoke

- [ ] **Step 1: Locate or write `Dockerfile.multi`**

Check if a Dockerfile already exists for multi mode (look for `Dockerfile`, `docker/`, or `.docker/` at repo root, and read `package.json` scripts for `docker:` entries). If absent, create:

```dockerfile
# Dockerfile.multi
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY vite.config.ts ./
RUN npm run build:all

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY src/multi/db/migrations ./src/multi/db/migrations
EXPOSE 3777
ENV BETSY_MODE=multi
CMD ["node", "dist/multi/server.js"]
```

If an existing Dockerfile produces single-mode, parameterize via `BETSY_MODE` env var or keep both Dockerfiles (this `Dockerfile.multi` for multi-mode).

- [ ] **Step 2: Smoke build locally**

```bash
docker build -t betsyai/betsy-multi:dev -f Dockerfile.multi .
docker run --rm -p 3777:3777 -e BC_DATABASE_URL=postgres://... -e BC_JWT_SECRET=test betsyai/betsy-multi:dev
```

Expected: container starts, `curl localhost:3777/healthz` returns 200.

- [ ] **Step 3: GitHub Actions release workflow**

```yaml
# .github/workflows/release-engine.yml
name: release-engine
on:
  push:
    tags: ['engine-v*']

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Extract version from tag
        id: ver
        run: echo "version=${GITHUB_REF#refs/tags/engine-v}" >> "$GITHUB_OUTPUT"
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: Dockerfile.multi
          push: true
          tags: |
            ghcr.io/betsyai/betsy-multi:${{ steps.ver.outputs.version }}
            ghcr.io/betsyai/betsy-multi:latest
      - name: Update engine manifest in R2
        env:
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          VERSION: ${{ steps.ver.outputs.version }}
        run: |
          cat > /tmp/latest.json <<EOF
          {
            "version": "$VERSION",
            "image": "ghcr.io/betsyai/betsy-multi:$VERSION",
            "min_shell_version": "0.1.0",
            "released_at": "$(date -u +%FT%TZ)"
          }
          EOF
          npx --yes @cloudflare/r2-uploader upload /tmp/latest.json betsy-updates/engine/latest.json
          # If @cloudflare/r2-uploader doesn't exist, use aws-cli with R2 S3-compatible endpoint instead.
```

If `@cloudflare/r2-uploader` doesn't exist on npm, fall back to AWS CLI with R2's S3 endpoint:

```bash
aws s3 cp /tmp/latest.json s3://betsy-updates/engine/latest.json \
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com
```

- [ ] **Step 4: Test workflow with a pre-release tag**

```bash
git tag engine-v0.1.0-rc1
git push origin engine-v0.1.0-rc1
# Watch Actions tab for green run
```

Verify:
- `ghcr.io/betsyai/betsy-multi:0.1.0-rc1` exists
- `https://updates.betsyai.io/engine/latest.json` returns the manifest

- [ ] **Step 5: Commit**

```bash
git add Dockerfile.multi .github/workflows/release-engine.yml
git commit -m "ci(infra): build & push betsy-multi to GHCR on engine-v* tags"
```

---

## Task 2: Electron installer build + publish

**Files:**
- Create: `.github/workflows/release-app.yml`
- Test: dry-run release with pre-release tag

- [ ] **Step 1: Workflow**

```yaml
# .github/workflows/release-app.yml
name: release-app
on:
  push:
    tags: ['app-v*']

jobs:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Install root deps (workspace requires)
        run: npm ci
      - name: Install betsy-app deps
        working-directory: betsy-app
        run: npm ci
      - name: Extract version from tag
        id: ver
        shell: bash
        run: echo "version=${GITHUB_REF#refs/tags/app-v}" >> "$GITHUB_OUTPUT"
      - name: Bump betsy-app version
        working-directory: betsy-app
        shell: bash
        run: npm version ${{ steps.ver.outputs.version }} --no-git-tag-version --allow-same-version
      - name: Build + sign + publish
        working-directory: betsy-app
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          WIN_CSC_LINK: ${{ secrets.WIN_CSC_LINK }}     # empty if EV not yet procured
          WIN_CSC_KEY_PASSWORD: ${{ secrets.WIN_CSC_KEY_PASSWORD }}
        run: npx electron-builder --win --x64 --publish always
      - name: Upload installer to R2
        env:
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
          VERSION: ${{ steps.ver.outputs.version }}
        shell: bash
        run: |
          for f in betsy-app/release/*.exe betsy-app/release/latest.yml betsy-app/release/*.blockmap; do
            aws s3 cp "$f" "s3://betsy-updates/electron/win-x64/$(basename "$f")" \
              --endpoint-url "https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com"
          done
          # Update "latest" symlink-style file
          cp betsy-app/release/Betsy-Setup-$VERSION.exe /tmp/Betsy-Setup-latest.exe
          aws s3 cp /tmp/Betsy-Setup-latest.exe s3://betsy-updates/electron/win-x64/Betsy-Setup-latest.exe \
            --endpoint-url "https://${{ secrets.R2_ACCOUNT_ID }}.r2.cloudflarestorage.com"
```

`electron-builder` already publishes `latest.yml` to the `publish` provider configured in `electron-builder.json` (P1.B Task 1). The R2 upload step is a fallback if `publish: always` doesn't reach R2 (R2 isn't a built-in `provider` — `generic` provider with HTTP PUT may or may not work; the explicit `aws s3 cp` is the reliable path).

- [ ] **Step 2: Pre-release tag test**

```bash
# After P1.B is in main:
git tag app-v0.1.0-rc1
git push origin app-v0.1.0-rc1
```

Verify:
- `https://updates.betsyai.io/electron/win-x64/latest.yml` exists
- `https://updates.betsyai.io/electron/win-x64/Betsy-Setup-0.1.0-rc1.exe` downloads
- `https://updates.betsyai.io/electron/win-x64/Betsy-Setup-latest.exe` is the same as above

- [ ] **Step 3: Smoke install**

Download installer on a clean Windows VM (or Sandbox). Install, run, verify wizard opens and pulls catalog from production API. Confirm SmartScreen behaviour: with EV cert — clean; without — "unrecognized publisher" warning that user can click through.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release-app.yml
git commit -m "ci(infra): build & publish Electron installer on app-v* tags"
```

---

## Task 3: Persona asset upload (CDN seeding)

**Files:**
- Create: `scripts/upload-persona-assets.ts`

For each preset in `src/multi/personas/presets.ts`, the `avatar.static` URL must resolve to a real image at `cdn.betsyai.io`. Without this step, both PersonaCache (P1.B Task 3) and main window AvatarPanel show broken images.

- [ ] **Step 1: Source images**

Put preset assets under `assets/presets/<id>/avatar.webp` in the repo. Initial pair:
- `assets/presets/betsy-default/avatar.webp` — ~512x512, WebP, warm friendly portrait
- `assets/presets/betsy-pro/avatar.webp` — ~512x512, WebP, professional portrait

Real assets are commissioned art / Stable Diffusion / Midjourney output. Until commissioned, ship placeholder neutral PNGs and document this in the PR.

- [ ] **Step 2: Upload script**

```typescript
// scripts/upload-persona-assets.ts
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, basename } from 'node:path'

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID!
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID!
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY!

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
})

const root = 'assets/presets'
for (const presetId of readdirSync(root)) {
  const dir = join(root, presetId)
  if (!statSync(dir).isDirectory()) continue
  for (const file of readdirSync(dir)) {
    const local = join(dir, file)
    const key = `presets/${presetId}/${file}`
    const ext = extname(file).toLowerCase()
    const contentType =
      ext === '.webp' ? 'image/webp' :
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.mp3' ? 'audio/mpeg' :
      'application/octet-stream'
    console.log(`uploading ${local} → s3://betsy-cdn/${key}`)
    await s3.send(new PutObjectCommand({
      Bucket: 'betsy-cdn',
      Key: key,
      Body: readFileSync(local),
      ContentType: contentType,
      CacheControl: 'public, max-age=86400',
    }))
  }
}
console.log('done')
```

- [ ] **Step 3: Run upload**

```bash
R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... npx tsx scripts/upload-persona-assets.ts
```

Expected: 2 uploads succeed. Verify in browser:
- `https://cdn.betsyai.io/presets/betsy-default/avatar.webp` returns 200
- `https://cdn.betsyai.io/presets/betsy-pro/avatar.webp` returns 200

- [ ] **Step 4: Commit**

```bash
git add scripts/upload-persona-assets.ts assets/presets/
git commit -m "chore(infra): persona asset upload script + initial placeholder avatars"
```

---

## Task 4: Production deployment of multi server (catalog + auth endpoints)

The P1.A endpoints (`/catalog/personas`, `/auth/tg-link/*`) live in `src/multi/server.ts`. They need to be running on production for the Windows installer to function. Per memory `reference_vps_services.md`, `betsy-multi` is already deployed at `/opt/betsy-multi/`.

- [ ] **Step 1: Deploy P1.A changes to production**

After P1.A is merged:
```bash
ssh root@<betsy-prod-vps>
cd /opt/betsy-multi
git pull
npm run build:all
npm run migrate    # applies 014_tg_link_nonces.sql
pm2 restart betsy-multi   # or whatever process manager is in use
```

Verify:
```bash
curl https://api.betsyai.io/catalog/personas
curl -X POST https://api.betsyai.io/auth/tg-link/start -d '{"presetId":"betsy-default"}' -H 'content-type: application/json'
```

Both return 200.

- [ ] **Step 2: Configure `BC_TG_BOT_USERNAME=betsyai_bot` in production env**

The TgLinkService needs to know the bot username to build deep links. Update production `.env` and restart.

- [ ] **Step 3: Smoke test deep link end-to-end**

From the production-pointing Windows app (built via P1.B), run the wizard, click "Войти через Telegram", confirm browser opens `t.me/betsyai_bot?start=...`, press Start, confirm wizard advances to done.

---

## Task 5: Public download page

**Files:**
- Create: `marketing-site/download.html` (or wherever betsyai.io content lives)

Per memory `reference_domain.md`, `betsyai.io` is the main domain. Find where its content is hosted (separate repo? Cloudflare Pages?).

- [ ] **Step 1: Locate marketing site**

Check for `marketing-site/`, `web/`, or a separate repo. If not in this repo, document the location and skip this task (handled by marketing team).

- [ ] **Step 2: Add download page**

```html
<!-- download.html (minimal) -->
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Скачать Бетси</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 80px auto; padding: 0 24px; color: #222 }
    h1 { font-size: 2.5em }
    .download-btn {
      display: inline-block; padding: 16px 32px; background: #2563eb; color: white;
      border-radius: 8px; text-decoration: none; font-size: 18px; font-weight: 500;
    }
    .system-req { color: #666; font-size: 14px; margin-top: 12px }
  </style>
</head>
<body>
  <h1>Скачать Бетси</h1>
  <p>AI-ассистент для Windows. Бесплатная установка, подписка на хостинг или self-host на твоём VPS.</p>
  <a class="download-btn" href="https://updates.betsyai.io/electron/win-x64/Betsy-Setup-latest.exe">
    Скачать для Windows ⬇
  </a>
  <div class="system-req">Windows 10/11 · 64-bit · ~150 MB</div>
  <h2>Что внутри</h2>
  <ul>
    <li>Wizard первого запуска — выбираешь персонажа и режим работы</li>
    <li>Чат с аватаром в нативном окне + параллельно через Telegram</li>
    <li>Self-host: ставится на твой VPS по SSH одной кнопкой</li>
    <li>Hosted: подписка, мы хостим у себя</li>
  </ul>
</body>
</html>
```

- [ ] **Step 3: Verify**

After deployment, `https://betsyai.io/download` shows the page and the button initiates the installer download from R2.

---

## Task 6: Engine update manifest hand-off

This task closes the loop on engine self-host updates (P1.B Task 15 reads this manifest).

- [ ] **Step 1: Confirm release-engine.yml writes the manifest**

The workflow in Task 1 already does this. Verify:
```bash
curl https://updates.betsyai.io/engine/latest.json
# Expected: { "version": "X.Y.Z", "image": "ghcr.io/betsyai/betsy-multi:X.Y.Z", "min_shell_version": "...", "released_at": "..." }
```

- [ ] **Step 2: Document manifest contract in repo**

```markdown
<!-- docs/update-manifests.md -->
# Update manifests

## Engine — `https://updates.betsyai.io/engine/latest.json`
Read by Windows app for self-host engine updates.
{
  "version": "string semver",
  "image": "full docker image reference",
  "min_shell_version": "string semver",
  "released_at": "ISO 8601"
}

## Electron — `https://updates.betsyai.io/electron/win-x64/latest.yml`
electron-updater format. Generated automatically by electron-builder.
```

- [ ] **Step 3: Commit**

```bash
git add docs/update-manifests.md
git commit -m "docs(infra): document update manifest contracts"
```

---

## Task 7: Code-sign smoke verification (after EV arrives)

This is a verification task; only runnable after the EV cert is delivered (External 4).

- [ ] **Step 1: Encode cert + add secrets**

On the machine with the `.pfx`:
```bash
base64 -w0 betsy-codesign.pfx > betsy-codesign.pfx.b64
# Paste contents as GitHub secret WIN_CSC_LINK; password as WIN_CSC_KEY_PASSWORD
rm betsy-codesign.pfx.b64  # do not commit
```

- [ ] **Step 2: Trigger release with cert in place**

Bump tag: `app-v0.1.0-rc2` and push. Wait for workflow.

- [ ] **Step 3: Verify signature**

Download the resulting `Betsy-Setup-0.1.0-rc2.exe` and run:
```powershell
Get-AuthenticodeSignature .\Betsy-Setup-0.1.0-rc2.exe
```
Expected: `Status: Valid`, `SignerCertificate.Subject` contains "Betsy AI" or your registered EV name.

- [ ] **Step 4: SmartScreen smoke**

On a clean Windows 11 VM that has never seen this installer: download from `updates.betsyai.io` via browser, double-click. Expected: no "publisher unknown" warning, possibly a single "do you want to run this" → runs.

- [ ] **Step 5: Tag stable release**

If verification passes, retag `app-v0.1.0` (drop `-rc2` suffix) and push. This is the first public version.

---

## Task 8: Telemetry / error reporting (optional in P1, recommended)

Not strictly required for P1 but heavily improves debuggability of self-host installations.

- [ ] **Step 1: Add Sentry to betsy-app**

```bash
cd betsy-app && npm install @sentry/electron
```

```typescript
// betsy-app/src/main/sentry.ts
import * as Sentry from '@sentry/electron/main'
if (process.env.BC_SENTRY_DSN) {
  Sentry.init({ dsn: process.env.BC_SENTRY_DSN, release: app.getVersion() })
}
```

Wire in `index.ts` before window creation. Sentry DSN goes in user env var or hardcoded at build time via electron-builder `extraMetadata`.

- [ ] **Step 2: Add Sentry to engine**

Similar setup in `src/multi/server.ts`. DSN as `BC_SENTRY_DSN` env var.

- [ ] **Step 3: Commit (if implementing)**

```bash
git add betsy-app/src/main/sentry.ts betsy-app/package.json
git commit -m "feat(betsy-app): optional Sentry error reporting"
```

---

## Final checks

- [ ] All workflows green for a real release sequence:
  - Tag `engine-v0.1.0` → image in GHCR + `/engine/latest.json` updated
  - Tag `app-v0.1.0-rc1` → installer in R2 + `/electron/win-x64/latest.yml` updated
  - Manual install on clean VM → wizard opens → hosted login → main chat window appears
- [ ] EV cert procured and applied (External 4 completed)
- [ ] `betsyai.io/download` live and serving latest installer
- [ ] `cdn.betsyai.io` serving persona avatars
- [ ] Production multi-server has P1.A endpoints reachable

---

## Notes for executor

- **Most of this plan is configuration, not code.** Don't try to write tests for "Cloudflare R2 bucket exists" — verify with `curl` and document.
- **EV cert lead time is the longest path.** Start External 4 on day 1 of P1 work even if all other tasks are still in planning. Identity validation needs business documents and ~7 days.
- **R2 vs S3:** R2 is S3-compatible. AWS CLI works with `--endpoint-url`. No region; use `auto`.
- **GHCR public visibility:** packages are private by default. Once first stable release ships, set `betsy-multi` package to public so self-host VPS can pull without GHCR auth (which would require shipping tokens in installer — bad).
- **Tag conventions:** `engine-vX.Y.Z` for engine releases, `app-vX.Y.Z` for installer releases. Separate so we can ship engine fixes without rebuilding the installer.
- **Cost budget:** R2 + Cloudflare DNS ~$5/month for traffic up to ~100GB. GHCR free for public packages. EV cert ~$300-500/yr. Sentry free tier is enough until ~5K users.
- **Don't sign with self-signed in production.** Without EV, ship unsigned and accept SmartScreen warning. Self-signed certs can confuse virus scanners into flagging the installer.
