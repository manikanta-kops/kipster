-- Files an execution attaches by path to one message or delegation, one row per file in call order.
CREATE TABLE kipster.artifact_file_attachments (
  attempt_id uuid NOT NULL REFERENCES kipster.attempts(id),
  call_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  request_sha256 text NOT NULL,
  artifact_id uuid NOT NULL REFERENCES kipster.artifacts(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('staging','ready','failed')),
  PRIMARY KEY (attempt_id,call_id,ordinal)
);
