CREATE TABLE kipster.vector_collections (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  owner_kind text NOT NULL CHECK (owner_kind IN ('agent','organization')),
  owner_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,39}$'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id,owner_kind,owner_id,name)
);

CREATE TABLE kipster.vector_records (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES kipster.vector_collections(id) ON DELETE CASCADE,
  record_key text NOT NULL CHECK (length(record_key) BETWEEN 1 AND 100),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 8192),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  source_hash text NOT NULL,
  source_bytes integer NOT NULL CHECK (source_bytes > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id,record_key)
);

CREATE TABLE kipster.vector_sources (
  record_id uuid NOT NULL REFERENCES kipster.vector_records(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  text text NOT NULL,
  metadata jsonb NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(record_id,revision)
);

CREATE TABLE kipster.vector_index_intents (
  record_id uuid NOT NULL,
  source_revision integer NOT NULL,
  source_hash text NOT NULL,
  generation bigint NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','processing','ready','failed','stale')),
  failure text,
  embedding vector,
  dimension integer,
  lease_owner uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(record_id,source_revision,generation),
  FOREIGN KEY(record_id,source_revision) REFERENCES kipster.vector_sources(record_id,revision) ON DELETE CASCADE
);

CREATE TABLE kipster.vector_tool_receipts (
  attempt_id uuid NOT NULL REFERENCES kipster.attempts(id),
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 200),
  operation text NOT NULL,
  arguments_hash text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(attempt_id,call_id)
);

CREATE INDEX vector_collections_owner ON kipster.vector_collections(installation_id,owner_kind,owner_id,name,id);

CREATE INDEX vector_records_collection ON kipster.vector_records(collection_id,id);

CREATE INDEX vector_intents_pending ON kipster.vector_index_intents(status,next_attempt_at,updated_at) WHERE status IN ('pending','processing','failed');
