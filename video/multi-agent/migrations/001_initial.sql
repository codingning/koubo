CREATE TABLE IF NOT EXISTS records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL,
  namespace TEXT,
  content_hash TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, id)
);

CREATE INDEX IF NOT EXISTS records_kind_status
ON records (kind, status);

CREATE INDEX IF NOT EXISTS records_namespace_status
ON records (namespace, status);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_subject_created
ON events (subject_id, created_at, id);

CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE IF NOT EXISTS transitions (
  id TEXT PRIMARY KEY,
  record_kind TEXT NOT NULL,
  record_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  prior_json TEXT NOT NULL,
  next_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rolled_back_at TEXT
);

CREATE INDEX IF NOT EXISTS transitions_record_created
ON transitions (record_kind, record_id, created_at, id);

CREATE TABLE IF NOT EXISTS agent_namespaces (
  agent_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read', 'write')),
  PRIMARY KEY (agent_id, namespace, access)
);

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id TEXT PRIMARY KEY,
  baseline_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  iteration INTEGER NOT NULL CHECK (iteration BETWEEN 0 AND 2),
  status TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
