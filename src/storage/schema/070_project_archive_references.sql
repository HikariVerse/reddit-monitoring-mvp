CREATE TABLE IF NOT EXISTS monitor_project_archive (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES monitor_project(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES collection_source(id) ON DELETE CASCADE,
  archive_id TEXT NOT NULL,
  version TEXT NOT NULL,
  scope JSONB NOT NULL,
  scope_hash TEXT NOT NULL,
  created_by UUID REFERENCES app_user(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, source_id, archive_id, version, scope_hash)
);

-- The table was created empty in this transaction, before any writer can use it.
-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS idx_monitor_project_archive_source ON monitor_project_archive(source_id);
