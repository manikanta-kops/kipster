CREATE TABLE kipster.voice_preparations (
  message_id uuid NOT NULL REFERENCES kipster.messages(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  artifact_id uuid NOT NULL REFERENCES kipster.artifacts(id),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('pending','preparing','succeeded','no-speech','unavailable')),
  provider_id text,
  attempt_id uuid REFERENCES kipster.attempts(id),
  transcript text,
  failure text,
  revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (message_id,ordinal),
  CHECK ((status IN ('succeeded','no-speech')) = (transcript IS NOT NULL))
);

CREATE TABLE kipster.voice_tool_calls (
  attempt_id uuid NOT NULL REFERENCES kipster.attempts(id),
  call_id text NOT NULL,
  artifact_id uuid NOT NULL REFERENCES kipster.artifacts(id),
  status text NOT NULL CHECK (status IN ('preparing','settled')),
  result jsonb,
  PRIMARY KEY (attempt_id,call_id)
);

CREATE INDEX voice_preparations_attempt ON kipster.voice_preparations(attempt_id) WHERE status='preparing';
