-- The nightly memory run (decision record 10, section 4) and the memory
-- settings of section 8.

-- Installation-wide memory settings. A null nightly model runs the nightly
-- steps with Kip's model; otherwise it is {"adapterId","modelId","effort"?}.
ALTER TABLE kipster.installations
  ADD COLUMN nightly_model jsonb CHECK (nightly_model IS NULL OR jsonb_typeof(nightly_model) = 'object'),
  ADD COLUMN core_card_count integer NOT NULL DEFAULT 60 CHECK (core_card_count BETWEEN 0 AND 200),
  ADD COLUMN search_card_count integer NOT NULL DEFAULT 10 CHECK (search_card_count BETWEEN 0 AND 50),
  ADD COLUMN search_chunk_count integer NOT NULL DEFAULT 6 CHECK (search_chunk_count BETWEEN 0 AND 30);

-- Each agent's nightly run. `night` is the last sleep day whose run finished
-- or gave up; a later sleep day is due. A failed run is tried again after
-- `retry_at` and given up after a few failures; its threads keep their
-- processed position, so the next night catches them up. `repick` is set
-- when a run changed cards and cleared once the core cards are re-picked, so
-- a failed re-pick is caught up even when no thread waits. `owner` is the Core
-- incarnation running the agent now: only that incarnation saves results or
-- records the run's outcome.
CREATE TABLE kipster.memory_nights (
  agent_id uuid PRIMARY KEY REFERENCES kipster.agents(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  night date,
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  failure text,
  retry_at timestamptz,
  repick boolean NOT NULL DEFAULT false,
  owner uuid,
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One model call of a nightly run, as work: its ID is the work intent, and
-- its attempt holds an execution permit while it runs.
CREATE TABLE kipster.memory_calls (
  id uuid PRIMARY KEY REFERENCES kipster.work_intents(id),
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  agent_id uuid REFERENCES kipster.agents(id) ON DELETE SET NULL,
  thread_id uuid REFERENCES kipster.threads(id) ON DELETE SET NULL,
  step text NOT NULL CHECK (step IN ('chunks','cards','diary','core')),
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','completed','failed')),
  failure text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memory_calls_running ON kipster.memory_calls(installation_id) WHERE state = 'running';
CREATE INDEX memory_calls_finished ON kipster.memory_calls(installation_id, updated_at) WHERE state <> 'running';
CREATE INDEX memory_nights_installation ON kipster.memory_nights(installation_id);
