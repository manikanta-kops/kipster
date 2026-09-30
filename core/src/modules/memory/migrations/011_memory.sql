CREATE TABLE kipster.memory_profiles (
  installation_id uuid PRIMARY KEY REFERENCES kipster.installations(id),
  provider text NOT NULL,
  model text NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  dimension integer,
  CHECK (generation > 0),
  CHECK (dimension IS NULL OR dimension > 0)
);

CREATE TABLE kipster.memory_records (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  scope text NOT NULL CHECK (scope IN ('agent','organization')),
  owner_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fact','observation','episode')),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 8192),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  source_hash text NOT NULL,
  published_from uuid REFERENCES kipster.memory_records(id) ON DELETE SET NULL,
  published_source_revision bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  origin text NOT NULL DEFAULT 'deliberate',
  importance real NOT NULL DEFAULT 1 CHECK (importance >= 0.2 AND importance <= 1),
  evidence integer NOT NULL DEFAULT 1 CHECK (evidence >= 1),
  refreshed_day bigint NOT NULL DEFAULT 0 CHECK (refreshed_day >= 0),
  -- Organization home of learned memories. A memory learned from an
  -- organization conversation keeps that organization as its home and surfaces
  -- only in executions of that organization. Every other agent memory is global.
  -- The home is set once, when the memory forms. It has no foreign key: after
  -- the organization is deleted its memories stay unreachable until they fade.
  home_organization_id uuid,
  CONSTRAINT memory_records_home_learned
    CHECK (home_organization_id IS NULL OR (scope = 'agent' AND origin = 'learned')),
  CONSTRAINT memory_records_origin_check CHECK (origin IN ('deliberate','learned','lesson')),
  -- Sleep compares newly learned or supported memories to existing memories,
  -- links or absorbs them, and may distil lessons. Lessons have no organization home.
  -- Evidence at the last consolidation; growth makes learned memory new material again.
  consolidated_evidence integer CHECK (consolidated_evidence IS NULL OR consolidated_evidence >= 1)
);

CREATE TABLE kipster.memory_embedding_generations (
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  generation bigint NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  dimension integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(installation_id,generation)
);

CREATE TABLE kipster.memory_sources (
  memory_id uuid NOT NULL REFERENCES kipster.memory_records(id),
  revision bigint NOT NULL,
  text text NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(memory_id,revision)
);

-- Message/thread/organization evidence survives deletion as tombstones; excerpts are purged.
CREATE TABLE kipster.memory_provenance (
  id uuid PRIMARY KEY,
  memory_id uuid NOT NULL REFERENCES kipster.memory_records(id),
  source_organization_id uuid,
  source_thread_id uuid,
  author_id uuid,
  subject text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  source_message_id uuid,
  source_message_revision bigint CHECK (source_message_revision IS NULL OR source_message_revision > 0),
  source_parts_hash text,
  excerpt text CHECK (excerpt IS NULL OR char_length(excerpt) <= 500),
  source_message_deleted boolean NOT NULL DEFAULT false,
  source_thread_deleted boolean NOT NULL DEFAULT false,
  source_organization_deleted boolean NOT NULL DEFAULT false,
  CONSTRAINT memory_provenance_org_fkey FOREIGN KEY (source_organization_id)
    REFERENCES kipster.organizations(id) ON DELETE SET NULL,
  CONSTRAINT memory_provenance_thread_fkey FOREIGN KEY (source_thread_id)
    REFERENCES kipster.threads(id) ON DELETE SET NULL
);

CREATE TABLE kipster.memory_index_intents (
  memory_id uuid NOT NULL REFERENCES kipster.memory_records(id),
  source_revision bigint NOT NULL,
  source_hash text NOT NULL,
  generation bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','processing','ready','failed','stale')),
  failure text,
  embedding vector,
  dimension integer,
  lease_owner uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(memory_id,source_revision,generation),
  FOREIGN KEY(memory_id,source_revision) REFERENCES kipster.memory_sources(memory_id,revision)
);

CREATE TABLE kipster.memory_tool_receipts (
  attempt_id uuid NOT NULL REFERENCES kipster.attempts(id),
  call_id text NOT NULL,
  operation text NOT NULL,
  arguments_hash text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(attempt_id,call_id)
);

CREATE TABLE kipster.memory_relationship_owner_versions (
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  owner_kind text NOT NULL CHECK (owner_kind IN ('agent','organization')),
  owner_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  relationship_count integer NOT NULL DEFAULT 0 CHECK (relationship_count BETWEEN 0 AND 2000),
  PRIMARY KEY (installation_id,owner_kind,owner_id)
);

CREATE TABLE kipster.memory_relationships (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  owner_kind text NOT NULL CHECK (owner_kind IN ('agent','organization')),
  owner_id uuid NOT NULL,
  from_id uuid NOT NULL REFERENCES kipster.memory_records(id),
  to_id uuid NOT NULL REFERENCES kipster.memory_records(id),
  kind text NOT NULL CHECK (kind IN ('supports','derived_from','contradicts','related_to')),
  weight double precision NOT NULL CHECK (weight >= 0 AND weight <= 1),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  active boolean NOT NULL DEFAULT true,
  from_revision bigint NOT NULL,
  to_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_id <> to_id)
);

CREATE TABLE kipster.memory_relationship_changes (
  relationship_id uuid NOT NULL REFERENCES kipster.memory_relationships(id),
  revision integer NOT NULL CHECK (revision >= 1),
  operation text NOT NULL CHECK (operation IN ('link','update','unlink')),
  actor_id uuid NOT NULL,
  attempt_id uuid REFERENCES kipster.attempts(id),
  kind text NOT NULL,
  weight double precision NOT NULL,
  active boolean NOT NULL,
  from_revision bigint NOT NULL,
  to_revision bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (relationship_id,revision)
);

CREATE TABLE kipster.memory_relationship_evidence (
  relationship_id uuid NOT NULL,
  relationship_revision integer NOT NULL,
  ordinal smallint NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  memory_id uuid NOT NULL REFERENCES kipster.memory_records(id),
  memory_revision bigint NOT NULL,
  source_hash text NOT NULL,
  provenance_id uuid REFERENCES kipster.memory_provenance(id),
  PRIMARY KEY (relationship_id,relationship_revision,ordinal),
  FOREIGN KEY (relationship_id,relationship_revision) REFERENCES kipster.memory_relationship_changes(relationship_id,revision)
);

-- Maintenance sources, runs, candidate claims, repair scheduling and operator
-- intents are claimed and executed only when the runtime opts in.
-- Durable per-completion extraction sources. run_id is a loose reference:
-- deletion hooks mark sources source_deleted (manifest NULL) instead of
-- deleting rows.
CREATE TABLE kipster.maintenance_sources (
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  run_id uuid NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision > 0),
  manifest_hash text NOT NULL,
  manifest jsonb,
  manifest_purged boolean NOT NULL DEFAULT false,
  agent_id uuid NOT NULL REFERENCES kipster.agents(id),
  context_kind text NOT NULL CHECK (context_kind IN ('installation','organization')),
  context_id uuid NOT NULL,
  source_thread_id uuid,
  status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready','claimed','issued','recovery','committed','skipped','fenced','superseded','source_deleted')),
  status_reason text,
  reserved boolean NOT NULL DEFAULT false,
  invalidated boolean NOT NULL DEFAULT false,
  claim_lease_until timestamptz,
  claim_incarnation uuid,
  tries_total integer NOT NULL DEFAULT 0 CHECK (tries_total BETWEEN 0 AND 5),
  prep_failed_tries integer NOT NULL DEFAULT 0 CHECK (prep_failed_tries BETWEEN 0 AND 3),
  issued_tries integer NOT NULL DEFAULT 0 CHECK (issued_tries BETWEEN 0 AND 2),
  cycles integer NOT NULL DEFAULT 0 CHECK (cycles BETWEEN 0 AND 3),
  next_eligible_at timestamptz NOT NULL DEFAULT now(),
  evidence_overflow boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, source_revision),
  UNIQUE (run_id, manifest_hash)
);

-- Exact attributed duplicate identity. The key columns plus memory_id and
-- recorded_memory_revision are immutable; only status and the diagnostic
-- flags change after insert. No claim text is stored.
CREATE TABLE kipster.maintenance_candidate_claims (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES kipster.agents(id),
  kind text NOT NULL CHECK (kind IN ('fact','observation','episode')),
  text_sha256 text NOT NULL,
  author_class text NOT NULL CHECK (author_class IN ('human','agent','unknown')),
  author_id uuid NOT NULL,
  context_kind text NOT NULL CHECK (context_kind IN ('installation','organization')),
  context_id uuid NOT NULL,
  subject_sha256 text NOT NULL,
  memory_id uuid NOT NULL REFERENCES kipster.memory_records(id),
  recorded_memory_revision bigint NOT NULL CHECK (recorded_memory_revision > 0),
  creating_provenance_id uuid REFERENCES kipster.memory_provenance(id),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','evidence_overflow','hash_collision_suspected')),
  source_run_id uuid NOT NULL,
  source_revision bigint NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 8),
  manual_text_overlap boolean NOT NULL DEFAULT false,
  context_tombstoned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, kind, text_sha256, author_class, author_id, context_kind, context_id, subject_sha256)
);

-- Sources are captured only when a run completes while learning is on, so the
-- repair scanner validates existing sources and never discovers missing ones.
-- Repair-only scanner epochs. last_run_id persists page progress; last_error
-- records the latest background failure for operator status.
CREATE TABLE kipster.maintenance_scheduler (
  installation_id uuid PRIMARY KEY REFERENCES kipster.installations(id),
  epoch_id bigint NOT NULL DEFAULT 1 CHECK (epoch_id > 0),
  last_run_id uuid,
  last_source_revision bigint,
  repair_inserts_used integer NOT NULL DEFAULT 0 CHECK (repair_inserts_used >= 0),
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  last_error_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Forgetting runs during sleep, which records its own progress.
CREATE TABLE kipster.memory_activity (
  agent_id uuid PRIMARY KEY REFERENCES kipster.agents(id) ON DELETE CASCADE,
  active_days bigint NOT NULL DEFAULT 0 CHECK (active_days >= 0),
  active_on date NOT NULL
);

-- Memory sleep. Each agent sleeps once per sleep day while it learns. A sleep
-- day starts at the agent's sleep time in the host's local time zone: the
-- installation default, unless the agent overrides it. Sleep runs a fixed
-- sequence of idempotent steps and records its progress, so a sleep
-- interrupted by a restart resumes where it stopped and a finished sleep is
-- never repeated for its day. Only the latest sleeps of each agent are kept.
CREATE TABLE kipster.memory_sleeps (
  id uuid PRIMARY KEY,
  agent_id uuid NOT NULL REFERENCES kipster.agents(id) ON DELETE CASCADE,
  sleep_on date NOT NULL,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','finished','skipped')),
  step text NOT NULL,
  report jsonb NOT NULL DEFAULT '{}',
  -- Failed attempts are retried after healthy sleeps so they cannot hold them back.
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT memory_sleeps_day UNIQUE (agent_id, sleep_on),
  CONSTRAINT memory_sleeps_finished CHECK ((state = 'running') = (finished_at IS NULL))
);

-- A maintenance run extracts a conversation source, consolidates frozen sleep input,
-- or promotes memories into identity.
-- Each maintenance execution has an id in the shared
-- work_intents/attempts/permit machinery; source rows are never deleted
-- outside the agent-brain purge path, which removes runs first. Provider
-- output is staged only while the run is running.
CREATE TABLE kipster.maintenance_runs (
  id uuid PRIMARY KEY REFERENCES kipster.work_intents(id),
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  source_run_id uuid,
  source_revision bigint,
  agent_id uuid NOT NULL REFERENCES kipster.agents(id),
  state text NOT NULL DEFAULT 'preparing'
    CHECK (state IN ('queued','preparing','running','recovery-needed','completed','failed')),
  current_attempt_id uuid REFERENCES kipster.attempts(id),
  failure_class text,
  failure text,
  permit_retained boolean NOT NULL DEFAULT false,
  reservation_reason text,
  adapter_id text,
  recovery_ref jsonb,
  recovery_ref_missing boolean NOT NULL DEFAULT false,
  recovery_impaired boolean NOT NULL DEFAULT false,
  staged_output jsonb,
  issued_at timestamptz,
  deadline_at timestamptz,
  last_reconcile_attempt timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (state = 'running' OR staged_output IS NULL),
  FOREIGN KEY (source_run_id, source_revision)
    REFERENCES kipster.maintenance_sources(run_id, source_revision),
  task_kind text NOT NULL DEFAULT 'extract',
  sleep_id uuid REFERENCES kipster.memory_sleeps(id) ON DELETE SET NULL,
  input jsonb,
  CONSTRAINT maintenance_runs_task_kind_check CHECK (task_kind IN ('extract','consolidate','identity')),
  CONSTRAINT maintenance_runs_task CHECK (
    (task_kind = 'extract' AND source_run_id IS NOT NULL AND source_revision IS NOT NULL AND input IS NULL)
    OR (task_kind IN ('consolidate','identity') AND source_run_id IS NULL AND source_revision IS NULL AND input IS NOT NULL))
);

-- Operator action intents. Appended by the shipped entry; executed only
-- by the running coordinator.
CREATE TABLE kipster.maintenance_operator_intents (
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  op_id text NOT NULL CHECK (length(op_id) BETWEEN 1 AND 200),
  action text NOT NULL CHECK (action IN ('skip-source','requeue-source','cancel','reconcile')),
  source_run_id uuid,
  source_revision bigint,
  maintenance_run_id uuid REFERENCES kipster.maintenance_runs(id),
  reason text,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','executing','done','rejected','orphaned')),
  lease_until timestamptz,
  executions integer NOT NULL DEFAULT 0 CHECK (executions >= 0),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, op_id)
);

-- Promotion into identity. During its sleep an agent rewrites the Learned
-- section of its identity.md from its strongest global memories, whenever that
-- set changed since the section was last built from it.
-- The memory revisions each agent's Learned section was last built from.
CREATE TABLE kipster.memory_promotions (
  agent_id uuid PRIMARY KEY REFERENCES kipster.agents(id) ON DELETE CASCADE,
  memories jsonb NOT NULL CHECK (jsonb_typeof(memories) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Memory strength. Strength is computed from stored inputs:
--   importance x (1 - 0.5^evidence) x 0.5^(age / (30 x evidence))
-- where age counts the owning agent's active days since the memory was last
-- supported or recalled. An agent's day counter advances only on days it runs
-- work while learning, so an idle agent forgets nothing.
CREATE FUNCTION kipster.memory_strength(importance real, evidence integer, age bigint) RETURNS double precision
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT importance * (1 - power(0.5, evidence)) * power(0.5, GREATEST(age, 0)::double precision / (30 * evidence)) $$;

CREATE UNIQUE INDEX memory_publication_identity ON kipster.memory_records(owner_id,published_from) WHERE published_from IS NOT NULL;

CREATE INDEX memory_scope_owner ON kipster.memory_records(scope,owner_id,updated_at DESC);

CREATE INDEX memory_text_search ON kipster.memory_records USING gin (to_tsvector('simple',text));

CREATE INDEX memory_provenance_memory ON kipster.memory_provenance(memory_id);

CREATE INDEX memory_index_pending ON kipster.memory_index_intents(status,next_attempt_at,updated_at) WHERE status IN ('pending','failed','processing');

CREATE UNIQUE INDEX memory_relationship_active_edge ON kipster.memory_relationships(owner_kind,owner_id,from_id,to_id,kind) WHERE active;

CREATE INDEX memory_relationship_owner ON kipster.memory_relationships(installation_id,owner_kind,owner_id,id);

CREATE INDEX memory_relationship_to ON kipster.memory_relationships(to_id) WHERE active;

CREATE INDEX maintenance_sources_admissible ON kipster.maintenance_sources(installation_id, next_eligible_at)
  WHERE status = 'ready';

CREATE INDEX maintenance_sources_run ON kipster.maintenance_sources(run_id, source_revision);

CREATE INDEX maintenance_runs_owner ON kipster.maintenance_runs(installation_id, state)
  WHERE state IN ('preparing','running','recovery-needed');

CREATE INDEX maintenance_runs_source ON kipster.maintenance_runs(source_run_id, source_revision);

CREATE INDEX maintenance_claims_memory ON kipster.maintenance_candidate_claims(memory_id);

CREATE INDEX maintenance_claims_source ON kipster.maintenance_candidate_claims(source_run_id, source_revision);

CREATE INDEX maintenance_intents_pending ON kipster.maintenance_operator_intents(installation_id, state)
  WHERE state IN ('pending','executing');

-- Crash-safe per-source evidence receipt identity. Manual rows keep NULL
-- message ids and are unaffected.
CREATE UNIQUE INDEX memory_provenance_evidence_identity ON kipster.memory_provenance(memory_id, source_message_id, source_message_revision);

-- Collision-checked manual-overlap and candidate scans (exact compare follows).
CREATE INDEX memory_records_maintenance_lookup ON kipster.memory_records(owner_id, kind, md5(text))
  WHERE scope = 'agent';

-- Forgetting deletes memories in bounded batches; these keep each delete and its foreign-key checks indexed.
CREATE INDEX memory_relationship_from ON kipster.memory_relationships(from_id);

CREATE INDEX memory_relationship_to_any ON kipster.memory_relationships(to_id);

CREATE INDEX memory_relationship_evidence_memory ON kipster.memory_relationship_evidence(memory_id);

CREATE INDEX memory_records_published_from ON kipster.memory_records(published_from) WHERE published_from IS NOT NULL;

-- Forgetting removes tool receipts that hold a copy of a memory's text.
CREATE INDEX memory_tool_receipts_record ON kipster.memory_tool_receipts ((result->'record'->>'id'))
  WHERE operation IN ('memory.save','memory.correct');

-- At most one sleep per agent is in progress.
CREATE UNIQUE INDEX memory_sleeps_running ON kipster.memory_sleeps(agent_id) WHERE state = 'running';

-- Deleting an organization deletes the learned memories homed in it.
CREATE INDEX memory_records_home ON kipster.memory_records(home_organization_id) WHERE home_organization_id IS NOT NULL;

CREATE INDEX maintenance_runs_sleep ON kipster.maintenance_runs(sleep_id) WHERE sleep_id IS NOT NULL;
