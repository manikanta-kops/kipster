CREATE TABLE kipster.app_streams (
  installation_id uuid PRIMARY KEY REFERENCES kipster.installations(id),
  next_position bigint NOT NULL DEFAULT 1,
  event_floor bigint NOT NULL DEFAULT 0
);

CREATE TABLE kipster.thread_events (
  thread_id uuid NOT NULL REFERENCES kipster.threads(id),
  position bigint NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  type text NOT NULL,
  resource_id uuid NOT NULL,
  revision bigint NOT NULL,
  data jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (thread_id, position)
);

CREATE TABLE kipster.app_events (
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  position bigint NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  type text NOT NULL,
  resource_id uuid NOT NULL,
  revision bigint NOT NULL,
  data jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, position)
);

CREATE TABLE kipster.app_thread_summaries (
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  caller_id uuid NOT NULL REFERENCES kipster.people(id),
  thread_id uuid NOT NULL REFERENCES kipster.threads(id),
  chat_id uuid NOT NULL REFERENCES kipster.direct_chats(id),
  revision bigint NOT NULL,
  state text NOT NULL,
  last_message_id uuid NOT NULL,
  PRIMARY KEY (installation_id, caller_id, thread_id)
);

CREATE TABLE kipster.app_projection_intents (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  thread_id uuid NOT NULL REFERENCES kipster.threads(id),
  resource_revision bigint NOT NULL,
  app_position bigint NOT NULL,
  projected boolean NOT NULL DEFAULT false,
  UNIQUE (installation_id, app_position)
);

CREATE TABLE kipster.notifications (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  recipient_id uuid NOT NULL REFERENCES kipster.people(id),
  thread_id uuid NOT NULL REFERENCES kipster.threads(id),
  run_id uuid NOT NULL REFERENCES kipster.text_runs(id),
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  CONSTRAINT notifications_kind_check CHECK (kind IN ('completed','failed','recovery-needed','interaction')),
  interaction_id uuid REFERENCES kipster.interactions(id),
  -- Reading a notification or settling, cancelling or superseding its interaction
  -- takes the next revision and publishes the whole record.
  revision bigint NOT NULL DEFAULT 1
);

-- A chat is present while its agent is not being deleted and, for an organization chat, while the
-- organization is not being deleted. Clients are told that any other chat, and its threads and
-- notifications, are gone.
CREATE FUNCTION kipster.chat_present(chat uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM kipster.direct_chats c
      JOIN kipster.agents a ON a.id = c.agent_id
      LEFT JOIN kipster.organizations o ON c.context_kind = 'organization' AND o.id = c.context_id
    WHERE c.id = chat
      AND a.lifecycle NOT IN ('deleting', 'deleted')
      AND (c.context_kind = 'installation' OR o.lifecycle NOT IN ('deleting', 'deleted')))
$$;

CREATE UNIQUE INDEX notifications_terminal_identity ON kipster.notifications(run_id,kind) WHERE interaction_id IS NULL;

CREATE UNIQUE INDEX notifications_interaction_identity ON kipster.notifications(interaction_id) WHERE interaction_id IS NOT NULL;

CREATE INDEX notifications_chronological ON kipster.notifications (installation_id, recipient_id, created_at, id);
