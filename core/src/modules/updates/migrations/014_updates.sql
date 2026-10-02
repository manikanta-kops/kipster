CREATE TABLE kipster.update_settings (
  installation_id uuid PRIMARY KEY REFERENCES kipster.installations(id),
  channel text NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'next')),
  mode text NOT NULL DEFAULT 'automatic' CHECK (mode IN ('automatic', 'notify')),
  pinned text,
  status jsonb NOT NULL DEFAULT '{}'::jsonb,
  updater_status jsonb,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

-- A durable outbox closes the database/file handoff gap. A replay keeps the same ID.
CREATE TABLE kipster.update_requests (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  request jsonb NOT NULL,
  delivered boolean NOT NULL DEFAULT false,
  terminal boolean NOT NULL DEFAULT false
);

-- This row is already the shared admission lock for text and maintenance work.
-- The gate survives Core's restart until the updater reports a terminal result.
ALTER TABLE kipster.execution_permits ADD COLUMN update_request_id text;
