-- Migration 071: Research reports, drafts, runs, schedules, explore study snapshots, and project research classification

ALTER TABLE monitor_project
  ADD COLUMN IF NOT EXISTS origin_kind TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE monitor_project
  ADD COLUMN IF NOT EXISTS research_goal TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'monitor_project_origin_kind_check'
  ) THEN
    ALTER TABLE monitor_project
      ADD CONSTRAINT monitor_project_origin_kind_check
      CHECK (origin_kind IN ('manual', 'quick_research', 'tracking')) NOT VALID;
    ALTER TABLE monitor_project
      VALIDATE CONSTRAINT monitor_project_origin_kind_check;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS report_draft (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  template TEXT NOT NULL CHECK (template IN ('industry', 'commerce', 'social', 'custom')),
  title TEXT NOT NULL DEFAULT '',
  input_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  discovery_json JSONB,
  plan_json JSONB,
  sections_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  project_id UUID REFERENCES monitor_project(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS idx_report_draft_owner_updated
  ON report_draft (owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS report_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  project_id UUID REFERENCES monitor_project(id) ON DELETE SET NULL,
  monitor_id UUID REFERENCES intel_monitor(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  template TEXT NOT NULL CHECK (template IN ('industry', 'commerce', 'social', 'custom')),
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly', 'monthly', 'custom_interval')),
  interval_minutes INTEGER CHECK (interval_minutes IS NULL OR interval_minutes >= 1),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  window_hours INTEGER NOT NULL DEFAULT 24 CHECK (window_hours >= 1 AND window_hours <= 8760),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TIMESTAMPTZ NOT NULL,
  last_run_at TIMESTAMPTZ,
  last_run_id UUID,
  last_status TEXT,
  last_error TEXT,
  max_daily_tokens INTEGER NOT NULL DEFAULT 120000 CHECK (max_daily_tokens >= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS idx_report_schedule_due
  ON report_schedule (enabled, next_run_at ASC)
  WHERE enabled = TRUE;

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS idx_report_schedule_owner
  ON report_schedule (owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS report_run (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  draft_id UUID REFERENCES report_draft(id) ON DELETE SET NULL,
  schedule_id UUID REFERENCES report_schedule(id) ON DELETE SET NULL,
  schedule_slot TEXT,
  idempotency_key TEXT,
  template TEXT NOT NULL CHECK (template IN ('industry', 'commerce', 'social', 'custom')),
  title TEXT NOT NULL,
  project_id UUID REFERENCES monitor_project(id) ON DELETE SET NULL,
  scope_hash TEXT NOT NULL,
  data_version TEXT NOT NULL DEFAULT '',
  plan_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  state TEXT NOT NULL DEFAULT 'preparing' CHECK (
    state IN (
      'draft', 'discovering', 'review', 'preparing', 'collecting',
      'analyzing', 'writing', 'ready', 'pure_data_ready',
      'needs_action', 'failed', 'cancel_requested', 'canceled'
    )
  ),
  stage_label TEXT NOT NULL DEFAULT '',
  step_progress_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  snapshot_json JSONB,
  narrative_checkpoint_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  llm_usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code TEXT,
  error_message TEXT,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  report_id UUID,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_run_owner_idem
  ON report_run (owner_user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- squawk-ignore require-concurrent-index-creation
CREATE UNIQUE INDEX IF NOT EXISTS idx_report_run_schedule_slot
  ON report_run (schedule_id, schedule_slot)
  WHERE schedule_id IS NOT NULL AND schedule_slot IS NOT NULL;

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS idx_report_run_owner_created
  ON report_run (owner_user_id, created_at DESC);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS idx_report_run_active
  ON report_run (state, updated_at ASC)
  WHERE state IN ('preparing', 'collecting', 'analyzing', 'writing', 'cancel_requested');

CREATE TABLE IF NOT EXISTS report_document (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  project_id UUID REFERENCES monitor_project(id) ON DELETE SET NULL,
  project_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  run_id UUID UNIQUE REFERENCES report_run(id) ON DELETE SET NULL,
  schedule_id UUID REFERENCES report_schedule(id) ON DELETE SET NULL,
  template TEXT NOT NULL CHECK (template IN ('industry', 'commerce', 'social', 'custom')),
  schema_version TEXT NOT NULL DEFAULT '1.0',
  report_version INTEGER NOT NULL DEFAULT 1 CHECK (report_version >= 1),
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  mode TEXT NOT NULL DEFAULT 'llm_verified' CHECK (mode IN ('llm_verified', 'pure_data', 'partial_llm')),
  scope_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  sections_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS idx_report_document_owner_created
  ON report_document (owner_user_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS idx_report_document_project
  ON report_document (project_id, created_at DESC)
  WHERE deleted_at IS NULL AND project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS report_explore_study (
  study_id TEXT PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  project_id UUID REFERENCES monitor_project(id) ON DELETE SET NULL,
  archive_ref_id UUID,
  source_mode TEXT NOT NULL,
  scope_hash TEXT NOT NULL,
  data_version TEXT NOT NULL,
  request_json JSONB NOT NULL,
  response_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS idx_report_explore_study_owner_scope
  ON report_explore_study (owner_user_id, scope_hash, created_at DESC);
