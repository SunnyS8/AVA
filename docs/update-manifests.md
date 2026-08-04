# Update manifests

The Windows app (`betsy-app/`) checks two manifests on a regular cadence:
one for the Electron shell itself, and one for the engine container the
self-host user is running. Both live on Cloudflare R2 behind
`updates.betsyai.io`. The manifests are written by GitHub Actions on
every successful release tag — see `.github/workflows/release-engine.yml`
and `.github/workflows/release-app.yml`.

This document is the contract for both. Anything that reads or writes a
manifest **must** match these shapes; changes here are coordinated
changes across CI, Cloudflare R2, and the shell.

---

## Engine — `https://updates.betsyai.io/engine/latest.json`

Consumed by `betsy-app` to drive the "обновить мой сервер" flow on
self-host installations. Hosted users never see this — their engine is
rolled forward by us.

### Shape

```json
{
  "version": "0.1.0",
  "image": "ghcr.io/betsyai/betsy-multi:0.1.0",
  "min_shell_version": "0.1.0",
  "released_at": "2026-05-24T08:30:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `version` | string (semver, no `v`) | New engine version being announced. |
| `image` | string | Fully qualified container ref. Must be public on GHCR — self-host VPS pulls without auth. |
| `min_shell_version` | string (semver) | The minimum `betsy-app` version that speaks this engine's API. If the local shell is older the app self-updates **first**, then offers the engine update. |
| `released_at` | string (ISO-8601, UTC, `Z`) | Used for human-readable changelogs and ordering. |

### Producer

`.github/workflows/release-engine.yml` on `engine-v*` tag push or manual
dispatch. It composes the JSON inline and uploads with
`aws s3 cp --endpoint-url https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`
into `s3://betsy-updates/engine/latest.json`. `Cache-Control: public,
max-age=60` keeps Cloudflare's edge from serving stale manifests for
long after a release.

`MIN_SHELL_VERSION` is sourced from the GitHub Actions repo variable
`MIN_SHELL_VERSION` (defaults to `0.1.0` if unset). Bump that variable
**at the same time** as introducing a breaking change in the engine ↔
shell protocol.

### Consumer

`betsy-app/main/updater.ts` (P1.B) fetches the manifest periodically.
On a newer `version` the user is offered the update; the app then SSHes
into the user's VPS and runs `docker compose pull && docker compose up
-d`. The pinned image tag from `image` is what gets pulled — never
`:latest` from the user's machine.

### Failure modes

- Manifest returns 5xx or 404 → app treats engine as up-to-date and
  retries on the next interval. No nag.
- `min_shell_version` is newer than local shell → app refuses to apply
  the engine update and self-updates first.
- Engine HTTP responses with status `426 Upgrade Required` → app
  triggers shell self-update flow before retrying.

---

## Electron shell — `https://updates.betsyai.io/electron/win-x64/latest.yml`

Standard `electron-updater` manifest. The shape is owned by
`electron-updater` and is generated for us by `electron-builder` during
the release build — we do not write it by hand. Reproduced here for
reference; if `electron-updater` changes the format, that change wins.

### Shape (example)

```yaml
version: 0.1.0
files:
  - url: Betsy Setup 0.1.0.exe
    sha512: <base64 sha512>
    size: 157286400
path: Betsy Setup 0.1.0.exe
sha512: <base64 sha512>
releaseDate: '2026-05-24T08:35:00.000Z'
```

### Producer

`.github/workflows/release-app.yml` runs `electron-builder --win --x64
--publish always` against the `generic` provider configured in
`betsy-app/electron-builder.json`, which points at
`https://updates.betsyai.io/electron/win-x64`. The workflow then
mirrors `latest.yml`, the `.exe`, and the `.exe.blockmap` directly into
R2 as a belt-and-braces fallback to electron-builder's own upload.

### Consumer

`electron-updater` inside `betsy-app`. The default channel is `latest`.
Updates check every four hours by default, apply on next quit.

---

## Stable installer pointer — `https://updates.betsyai.io/electron/win-x64/Betsy-Setup-latest.exe`

A copy of the latest versioned `.exe` written under a stable name so the
download page (`betsyai.io/download`) can link to it without knowing
the current version. Updated by the same `release-app.yml` step that
publishes the versioned installer.

This is **not** consumed by `electron-updater` — that reads
`latest.yml`. It exists solely so a marketing page can hand out a
fixed URL.

---

## Bucket layout

```
betsy-updates/                          (R2, public via updates.betsyai.io)
  engine/
    latest.json                         engine manifest
  electron/
    win-x64/
      latest.yml                        electron-updater manifest
      Betsy Setup <version>.exe         versioned installer
      Betsy Setup <version>.exe.blockmap
      Betsy-Setup-latest.exe            stable pointer for the download page
```

```
betsy-cdn/                              (R2, public via cdn.betsyai.io)
  presets/
    <preset-id>/
      avatar.webp                       persona avatar referenced by the catalog
      ...
```

Populated by `scripts/upload-persona-assets.ts` — see that file's
header for usage.

---

## Tag conventions

| Tag | Triggers | Writes |
|---|---|---|
| `engine-vX.Y.Z` | `release-engine.yml` | `engine/latest.json`, `ghcr.io/betsyai/betsy-multi:X.Y.Z`, `:latest` |
| `app-vX.Y.Z` | `release-app.yml` | `electron/win-x64/latest.yml`, `Betsy Setup X.Y.Z.exe`, `Betsy-Setup-latest.exe` |

Engine and shell release independently — a backend fix should not
require re-shipping the installer.

---

## Manual smoke check after a release

```bash
curl -fsS https://updates.betsyai.io/engine/latest.json | jq .
curl -fsS https://updates.betsyai.io/electron/win-x64/latest.yml | head -20
curl -I  https://updates.betsyai.io/electron/win-x64/Betsy-Setup-latest.exe
```

All three must return successfully and reflect the new version.
