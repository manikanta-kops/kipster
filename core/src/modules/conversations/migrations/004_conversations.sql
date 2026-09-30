CREATE TABLE kipster.direct_chats (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  caller_id uuid NOT NULL REFERENCES kipster.people(id),
  context_kind text NOT NULL CHECK (context_kind IN ('installation','organization')),
  context_id uuid NOT NULL,
  agent_id uuid NOT NULL REFERENCES kipster.agents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, caller_id, context_kind, context_id, agent_id)
);

CREATE TABLE kipster.threads (
  id uuid PRIMARY KEY,
  chat_id uuid NOT NULL REFERENCES kipster.direct_chats(id),
  next_message_position bigint NOT NULL DEFAULT 1,
  next_queue_position bigint NOT NULL DEFAULT 1,
  next_event_position bigint NOT NULL DEFAULT 1,
  event_floor bigint NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  internal boolean NOT NULL DEFAULT false
);

CREATE TABLE kipster.messages (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES kipster.threads(id),
  position bigint NOT NULL,
  author_id uuid NOT NULL,
  parts jsonb NOT NULL,
  final boolean NOT NULL DEFAULT true,
  source_attempt_id uuid,
  publication_source text CHECK (publication_source IN ('native','tool')),
  publication_id text,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (thread_id, position),
  UNIQUE (source_attempt_id, publication_source, publication_id)
);

CREATE TABLE kipster.text_runs (
  id uuid PRIMARY KEY REFERENCES kipster.work_intents(id),
  thread_id uuid NOT NULL REFERENCES kipster.threads(id),
  input_message_id uuid NOT NULL REFERENCES kipster.messages(id),
  state text NOT NULL,
  queue_position bigint NOT NULL,
  current_attempt_id uuid,
  queue_hold boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1,
  failure text,
  UNIQUE (thread_id, queue_position),
  CONSTRAINT text_runs_state_check CHECK (state IN ('queued','preparing','running','waiting','cancellation-requested','completed','failed','cancelled','recovery-needed')),
  stop_requested boolean NOT NULL DEFAULT false,
  retry_continue_generation bigint,
  queue_generation bigint NOT NULL DEFAULT 0,
  continuation_interaction_id uuid,
  cancel_delivery text NOT NULL DEFAULT 'none' CHECK (cancel_delivery IN ('none','requested','acknowledged','uncertain','confirmed-ended','not-needed'))
);

CREATE TABLE kipster.execution_permits (
  installation_id uuid PRIMARY KEY REFERENCES kipster.installations(id),
  ceiling integer NOT NULL DEFAULT 20 CHECK (ceiling BETWEEN 1 AND 1000),
  delegation_depth_limit integer NOT NULL DEFAULT 4 CHECK (delegation_depth_limit BETWEEN 1 AND 16),
  delegation_root_budget integer NOT NULL DEFAULT 32 CHECK (delegation_root_budget BETWEEN 1 AND 1000),
  delegation_fanout_limit integer NOT NULL DEFAULT 4 CHECK (delegation_fanout_limit BETWEEN 1 AND 32),
  -- The fairness counter advances with every text admission.
  maintenance_counter bigint NOT NULL DEFAULT 0
    CHECK (maintenance_counter BETWEEN 0 AND 1000000)
);

CREATE TABLE kipster.owned_permits (
  attempt_id uuid PRIMARY KEY REFERENCES kipster.attempts(id),
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  acquired_at timestamptz NOT NULL DEFAULT now()
);
