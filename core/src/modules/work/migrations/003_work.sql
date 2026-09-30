CREATE TABLE kipster.receipts (
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  caller_id uuid NOT NULL REFERENCES kipster.people(id),
  submission_id text NOT NULL,
  receipt jsonb NOT NULL,
  PRIMARY KEY (installation_id, caller_id, submission_id)
);

CREATE TABLE kipster.work_intents (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  state text NOT NULL CHECK (state IN ('queued','preparing','issued','settled','uncertain')),
  generation bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kipster.attempts (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL REFERENCES kipster.work_intents(id),
  generation bigint NOT NULL,
  incarnation uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('preparing','issued','settled','uncertain')),
  UNIQUE (intent_id, generation),
  adapter_id text,
  adapter_generation_id uuid,
  runner_incarnation uuid,
  adapter_installation_digest text,
  adapter_installation_root text,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
