CREATE TABLE kipster.artifacts (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  owner_kind text NOT NULL CHECK (owner_kind IN ('installation','organization','agent')),
  owner_id uuid NOT NULL,
  source_id uuid REFERENCES kipster.artifacts(id) ON DELETE SET NULL,
  provenance text NOT NULL CHECK (provenance IN ('upload','generated','published')),
  author_id uuid NOT NULL,
  name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('staging','ready','failed','recovery-needed')),
  failure text,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kipster.artifact_uploads (
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  caller_id uuid NOT NULL REFERENCES kipster.people(id),
  upload_id uuid NOT NULL,
  artifact_id uuid NOT NULL REFERENCES kipster.artifacts(id) ON DELETE CASCADE,
  intent jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('staging','ready','failed')),
  claim_token uuid,
  claim_expires_at timestamptz,
  PRIMARY KEY (installation_id,caller_id,upload_id)
);

CREATE TABLE kipster.message_artifacts (
  message_id uuid NOT NULL REFERENCES kipster.messages(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  artifact_id uuid NOT NULL REFERENCES kipster.artifacts(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('attachment','voice_note')),
  PRIMARY KEY (message_id,ordinal)
);

CREATE TABLE kipster.artifact_publications (
  attempt_id uuid NOT NULL REFERENCES kipster.attempts(id),
  call_id text NOT NULL,
  input_id uuid NOT NULL,
  request_sha256 text NOT NULL,
  artifact_id uuid NOT NULL REFERENCES kipster.artifacts(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('staging','ready','failed')),
  PRIMARY KEY (attempt_id,call_id)
);

CREATE TABLE kipster.artifact_output_writes (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES kipster.attempts(id),
  call_id text NOT NULL,
  name text NOT NULL,
  request_sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  state text NOT NULL CHECK (state IN ('staging','ready','failed')),
  UNIQUE (attempt_id,call_id)
);

CREATE TABLE kipster.artifact_organization_copies (
  attempt_id uuid NOT NULL REFERENCES kipster.attempts(id),
  call_id text NOT NULL,
  source_id uuid REFERENCES kipster.artifacts(id) ON DELETE SET NULL,
  organization_id uuid NOT NULL REFERENCES kipster.organizations(id),
  artifact_id uuid NOT NULL REFERENCES kipster.artifacts(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('staging','ready','failed')),
  PRIMARY KEY (attempt_id,call_id)
);

CREATE INDEX artifact_recovery ON kipster.artifacts(state) WHERE state <> 'ready';
