-- Kip memory (decision record 10) replaces the first memory engine, which is
-- removed without keeping its data.

-- Work of the old engine leaves the shared work tables, and any execution
-- permit it still holds is released.
CREATE TEMPORARY TABLE retired_memory_runs ON COMMIT DROP AS SELECT id FROM kipster.maintenance_runs;
DELETE FROM kipster.owned_permits p USING kipster.attempts a
  WHERE a.id = p.attempt_id AND a.intent_id IN (SELECT id FROM retired_memory_runs);

DROP TABLE kipster.maintenance_operator_intents, kipster.maintenance_runs, kipster.maintenance_candidate_claims,
  kipster.maintenance_sources, kipster.maintenance_scheduler, kipster.memory_sleeps, kipster.memory_promotions,
  kipster.memory_activity, kipster.memory_relationship_evidence, kipster.memory_relationship_changes,
  kipster.memory_relationships, kipster.memory_relationship_owner_versions, kipster.memory_tool_receipts,
  kipster.memory_index_intents, kipster.memory_provenance, kipster.memory_sources, kipster.memory_records;
DROP FUNCTION kipster.memory_strength(real, integer, bigint);

DELETE FROM kipster.attempts WHERE intent_id IN (SELECT id FROM retired_memory_runs);
DELETE FROM kipster.work_intents WHERE id IN (SELECT id FROM retired_memory_runs);
ALTER TABLE kipster.execution_permits DROP COLUMN maintenance_counter;

-- The installation's embedding profile stays: vector collections are indexed with it.
ALTER TABLE kipster.memory_profiles RENAME TO embedding_profiles;
ALTER TABLE kipster.embedding_profiles RENAME CONSTRAINT memory_profiles_pkey TO embedding_profiles_pkey;
ALTER TABLE kipster.embedding_profiles RENAME CONSTRAINT memory_profiles_installation_id_fkey TO embedding_profiles_installation_id_fkey;
ALTER TABLE kipster.embedding_profiles RENAME CONSTRAINT memory_profiles_generation_check TO embedding_profiles_generation_check;
ALTER TABLE kipster.embedding_profiles RENAME CONSTRAINT memory_profiles_dimension_check TO embedding_profiles_dimension_check;
ALTER TABLE kipster.memory_embedding_generations RENAME TO embedding_generations;
ALTER TABLE kipster.embedding_generations RENAME CONSTRAINT memory_embedding_generations_pkey TO embedding_generations_pkey;
ALTER TABLE kipster.embedding_generations RENAME CONSTRAINT memory_embedding_generations_installation_id_fkey TO embedding_generations_installation_id_fkey;

-- How far the nightly run has processed each thread, by message position.
CREATE TABLE kipster.memory_thread_state (
  thread_id uuid PRIMARY KEY REFERENCES kipster.threads(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  processed_position bigint NOT NULL DEFAULT 0 CHECK (processed_position >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Searchable full-text pieces of a thread, private to the agent the thread
-- belongs to. Rows are saved first and embedded later; every embedding names
-- its model. started_at and ended_at are the times of the chunk's first and
-- last messages, for date-range search.
CREATE TABLE kipster.thread_chunks (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  thread_id uuid NOT NULL REFERENCES kipster.threads(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES kipster.agents(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES kipster.organizations(id) ON DELETE CASCADE,
  from_position bigint NOT NULL CHECK (from_position >= 1),
  to_position bigint NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  title text NOT NULL,
  text text NOT NULL CHECK (text <> ''),
  embedding vector(768),
  embedding_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_position >= from_position),
  CHECK (ended_at >= started_at),
  CHECK (embedding IS NULL OR embedding_model IS NOT NULL),
  UNIQUE (thread_id, from_position)
);

-- Facts about the user, shared by every agent of the installation. A card
-- learned in an organization thread carries that organization. A replaced
-- card keeps its row, ends at valid_to and names its replacement.
CREATE TABLE kipster.cards (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  type text NOT NULL CHECK (type <> ''),
  subject text NOT NULL CHECK (subject <> ''),
  statement text NOT NULL CHECK (statement <> ''),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  confirmed boolean NOT NULL DEFAULT false,
  core boolean NOT NULL DEFAULT false,
  organization_id uuid REFERENCES kipster.organizations(id) ON DELETE CASCADE,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  replaced_by uuid REFERENCES kipster.cards(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  embedding vector(768),
  embedding_model text,
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (embedding IS NULL OR embedding_model IS NOT NULL)
);

-- The user messages each card was learned from. A card left with no source is
-- deleted with the thread that removed its last one.
CREATE TABLE kipster.card_sources (
  card_id uuid NOT NULL REFERENCES kipster.cards(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES kipster.threads(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES kipster.messages(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, message_id)
);

-- One page per agent and day covered: a short summary and its threads.
CREATE TABLE kipster.diary (
  agent_id uuid NOT NULL REFERENCES kipster.agents(id) ON DELETE CASCADE,
  day date NOT NULL,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  summary text NOT NULL CHECK (summary <> ''),
  thread_ids uuid[] NOT NULL DEFAULT '{}',
  embedding vector(768),
  embedding_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (embedding IS NULL OR embedding_model IS NOT NULL),
  PRIMARY KEY (agent_id, day)
);

CREATE INDEX thread_chunks_embedding ON kipster.thread_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX cards_embedding ON kipster.cards USING hnsw (embedding vector_cosine_ops);
CREATE INDEX diary_embedding ON kipster.diary USING hnsw (embedding vector_cosine_ops);

CREATE INDEX thread_chunks_agent ON kipster.thread_chunks(agent_id, started_at);
CREATE INDEX thread_chunks_organization ON kipster.thread_chunks(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX thread_chunks_installation_day ON kipster.thread_chunks(installation_id, started_at);
CREATE INDEX thread_chunks_unembedded ON kipster.thread_chunks(installation_id) WHERE embedding IS NULL;
CREATE INDEX cards_current ON kipster.cards(installation_id, organization_id) WHERE valid_to IS NULL;
CREATE INDEX cards_core ON kipster.cards(installation_id) WHERE valid_to IS NULL AND core;
CREATE INDEX cards_organization ON kipster.cards(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX cards_replaced_by ON kipster.cards(replaced_by) WHERE replaced_by IS NOT NULL;
CREATE INDEX cards_unembedded ON kipster.cards(installation_id) WHERE embedding IS NULL;
CREATE INDEX card_sources_thread ON kipster.card_sources(thread_id);
CREATE INDEX card_sources_message ON kipster.card_sources(message_id);
CREATE INDEX diary_installation_day ON kipster.diary(installation_id, day);
CREATE INDEX diary_threads ON kipster.diary USING gin (thread_ids);
CREATE INDEX diary_unembedded ON kipster.diary(installation_id) WHERE embedding IS NULL;
