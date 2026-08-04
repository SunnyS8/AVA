-- 014_tg_link_nonces.sql — Telegram deep-link login nonces (P1.A).
--
-- Used by the Windows-app wizard. Flow:
--   1. Windows-app POST /auth/tg-link/start {presetId} → server creates a
--      random UUIDv4 nonce, stores (nonce, preset_id, expires_at=now()+5min).
--   2. App opens deep link https://t.me/<bot>?start=<nonce> in the browser.
--   3. User presses Start in TG → bot handler resolves nonce → preset_id →
--      creates/finds workspace, sets workspace_id + jwt + completed_at + used.
--   4. App long-polls GET /auth/tg-link/poll?nonce=<nonce> → receives the jwt.
--
-- Single-use: once a nonce is completed (used=true), findActive returns null
-- so a replayed /start cannot bind a new workspace to the same nonce.
--
-- All access goes through asAdmin — the target user has no workspace_id yet
-- at row-creation time. RLS is still enabled defensively so that any future
-- withWorkspace code path (e.g. cleanup of completed link by the workspace
-- owner) is scoped correctly.

create table if not exists bc_tg_link_nonces (
  nonce            text primary key,
  preset_id        text not null,
  expires_at       timestamptz not null,
  -- completion fields, null until /start <nonce> arrives
  workspace_id     uuid references workspaces(id) on delete cascade,
  jwt              text,
  completed_at     timestamptz,
  -- bookkeeping
  created_at       timestamptz not null default now(),
  used             boolean not null default false
);

create index if not exists bc_tg_link_nonces_expires_idx on bc_tg_link_nonces(expires_at);
create index if not exists bc_tg_link_nonces_completed_idx on bc_tg_link_nonces(completed_at)
  where completed_at is not null;

-- Bypasses RLS — accessed only via asAdmin (target user doesn't have workspace_id yet)
alter table bc_tg_link_nonces enable row level security;
alter table bc_tg_link_nonces force row level security;

-- Defensive policy for any future withWorkspace call (e.g. cleanup of completed link)
drop policy if exists ws_scoped on bc_tg_link_nonces;
create policy ws_scoped on bc_tg_link_nonces
  using (workspace_id = current_setting('app.workspace_id', true)::uuid);

grant select, insert, update, delete on bc_tg_link_nonces to bc_app;
