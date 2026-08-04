-- Fix3 — CoachAgent: persona tweak proposals.
-- Nightly the Coach inspects negative feedback and asks Gemini for minimal
-- search-and-replace edits to the persona's personality_prompt. Each edit is
-- stored here as a pending proposal; the user approves/rejects it through
-- list_persona_tweaks / approve_persona_tweak / reject_persona_tweak root
-- agent tools. Approving applies the diff to bc_personas.personality_prompt.
--
-- RLS isolates proposals per-workspace just like every other bc_* table.

CREATE TABLE IF NOT EXISTS bc_persona_tweak_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rationale TEXT NOT NULL,
  diff_before TEXT NOT NULL,
  diff_after TEXT NOT NULL,
  evidence_feedback_ids UUID[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  created_at TIMESTAMPTZ DEFAULT now(),
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '14 days')
);

ALTER TABLE bc_persona_tweak_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE bc_persona_tweak_proposals FORCE ROW LEVEL SECURITY;

CREATE POLICY persona_tweaks_ws_scoped ON bc_persona_tweak_proposals
  USING (workspace_id = current_setting('app.workspace_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON bc_persona_tweak_proposals TO bc_app;

CREATE INDEX IF NOT EXISTS bc_persona_tweaks_pending_idx
  ON bc_persona_tweak_proposals(workspace_id, status)
  WHERE status = 'pending';
