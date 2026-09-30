CREATE TABLE kipster.work_controls (
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  caller_id uuid NOT NULL REFERENCES kipster.people(id),
  operation_id text NOT NULL,
  thread_id uuid NOT NULL REFERENCES kipster.threads(id),
  run_id uuid NOT NULL REFERENCES kipster.text_runs(id),
  attempt_id uuid,
  action text NOT NULL CHECK (action IN ('stop','resume','retry','cancel-queued','steer')),
  outcome text NOT NULL CHECK (outcome IN ('accepted','unsupported','uncertain','failed','rejected')),
  reason text NOT NULL DEFAULT '',
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id,caller_id,operation_id)
);

CREATE TABLE kipster.interactions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES kipster.text_runs(id),
  attempt_id uuid NOT NULL REFERENCES kipster.attempts(id),
  call_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('question','approval')),
  proposal_id text,
  proposal text,
  prompt text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]',
  free_text boolean NOT NULL DEFAULT false,
  state text NOT NULL CHECK (state IN ('pending','settled','cancelled','superseded')),
  answer jsonb,
  answer_operation_id text,
  answer_actor_id uuid,
  answered_at timestamptz,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id,call_id)
);

CREATE TABLE kipster.interaction_receipts (
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  caller_id uuid NOT NULL REFERENCES kipster.people(id),
  operation_id text NOT NULL,
  interaction_id uuid NOT NULL REFERENCES kipster.interactions(id),
  outcome text NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id,caller_id,operation_id)
);

-- A delegation stays in the thread it was made from after the other side is permanently deleted.
-- Deleting an agent removes the runs it executed for other agents and the runs it delegated from
-- there, so those links become empty. The delegation keeps its request, result, state and both
-- agent IDs; a deleted agent keeps its name as a tombstone.
CREATE TABLE kipster.delegations (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  origin_thread_id uuid NOT NULL REFERENCES kipster.threads(id),
  root_run_id uuid NOT NULL REFERENCES kipster.text_runs(id),
  parent_run_id uuid REFERENCES kipster.text_runs(id),
  parent_attempt_id uuid REFERENCES kipster.attempts(id),
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 1000),
  child_run_id uuid UNIQUE REFERENCES kipster.text_runs(id),
  call_id text NOT NULL,
  sender_agent_id uuid NOT NULL REFERENCES kipster.agents(id),
  recipient_agent_id uuid NOT NULL REFERENCES kipster.agents(id),
  context_kind text NOT NULL CHECK (context_kind IN ('installation','organization')),
  context_id uuid NOT NULL,
  responsible_human_id uuid NOT NULL REFERENCES kipster.people(id),
  depth integer NOT NULL CHECK (depth BETWEEN 1 AND 16),
  request text NOT NULL,
  artifact_ids uuid[] NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK (state IN ('queued','running','waiting','completed','failed','cancelled','recovery-needed')),
  result text,
  failure text,
  late_result text,
  late_failure text,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (parent_attempt_id,call_id),
  UNIQUE (parent_run_id,ordinal),
  CHECK (sender_agent_id <> recipient_agent_id)
);

CREATE INDEX interactions_run_state ON kipster.interactions(run_id,state);

CREATE INDEX delegations_root ON kipster.delegations(root_run_id,created_at,id);

CREATE INDEX delegations_parent ON kipster.delegations(parent_run_id,state);

CREATE INDEX delegations_origin ON kipster.delegations(origin_thread_id,created_at,id);
