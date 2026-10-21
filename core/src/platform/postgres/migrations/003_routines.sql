-- Routines (decision record 13): work a kip does on its own when a trigger fires. Each run starts a new thread in
-- `chat_id`, the kip's chat with the person it acts for. `next_run_at` is null once no trigger fires again.
-- `request_key` makes a repeated create request return the first routine.
CREATE TABLE kipster.routines (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  chat_id uuid NOT NULL REFERENCES kipster.direct_chats(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES kipster.agents(id),
  person_id uuid NOT NULL REFERENCES kipster.people(id),
  created_by uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  instructions text NOT NULL CHECK (length(instructions) BETWEEN 1 AND 16000),
  triggers jsonb NOT NULL CHECK (jsonb_typeof(triggers) = 'array'),
  time_zone text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  request_key text UNIQUE,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX routines_due ON kipster.routines(next_run_at) WHERE enabled AND next_run_at IS NOT NULL;
CREATE INDEX routines_agent ON kipster.routines(agent_id);

-- One row per scheduled time: `started` with the thread it started, or `skipped` past the kip's daily limit. A time
-- runs once. "Run now" uses the time it was asked; its `request_key` makes a repeated request start nothing new.
-- A run keeps its routine's name, so its thread stays marked after the routine is deleted.
CREATE TABLE kipster.routine_runs (
  id uuid PRIMARY KEY,
  routine_id uuid REFERENCES kipster.routines(id) ON DELETE SET NULL,
  routine_name text NOT NULL,
  agent_id uuid NOT NULL REFERENCES kipster.agents(id),
  scheduled_for timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL CHECK (state IN ('started','skipped')),
  late boolean NOT NULL DEFAULT false,
  thread_id uuid REFERENCES kipster.threads(id) ON DELETE SET NULL,
  request_key text UNIQUE,
  UNIQUE (routine_id, scheduled_for)
);
CREATE INDEX routine_runs_agent_day ON kipster.routine_runs(agent_id, started_at) WHERE state = 'started';
CREATE INDEX routine_runs_thread ON kipster.routine_runs(thread_id) WHERE thread_id IS NOT NULL;

-- The most routine runs one kip starts a day, across its routines.
ALTER TABLE kipster.installations ADD COLUMN routine_daily_limit integer NOT NULL DEFAULT 50 CHECK (routine_daily_limit BETWEEN 1 AND 1000);

ALTER TABLE kipster.text_runs DROP CONSTRAINT text_runs_trigger_kind_check;
ALTER TABLE kipster.text_runs ADD CONSTRAINT text_runs_trigger_kind_check CHECK (trigger_kind IN ('person','kip','answer','routine'));
