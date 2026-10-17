-- Kipster's database schema. Schema changes add a new numbered migration after this one.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS kipster;

-- Identity ------------------------------------------------------------------

-- Learning switches. An agent learns only while both its installation switch
-- (off by default) and its own switch (on by default) are on. Revisions count
-- changes for clients that apply learning-changed events.
-- Memory settings: a null nightly model runs the nightly steps with the admin
-- kip's model; otherwise it is {"adapterId","modelId","effort"?}.
CREATE TABLE kipster.installations (
  id uuid PRIMARY KEY,
  singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  created_at timestamptz NOT NULL DEFAULT now(),
  learning_enabled boolean NOT NULL DEFAULT false,
  learning_revision bigint NOT NULL DEFAULT 0 CHECK (learning_revision >= 0),
  sleep_time time(0) NOT NULL DEFAULT '01:00',
  nightly_model jsonb CHECK (nightly_model IS NULL OR jsonb_typeof(nightly_model) = 'object'),
  core_card_count integer NOT NULL DEFAULT 60 CHECK (core_card_count BETWEEN 0 AND 200),
  search_card_count integer NOT NULL DEFAULT 10 CHECK (search_card_count BETWEEN 0 AND 50),
  search_chunk_count integer NOT NULL DEFAULT 6 CHECK (search_chunk_count BETWEEN 0 AND 30)
);

CREATE TABLE kipster.people (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  display_name text NOT NULL
);

-- Directory: lifecycle and revisions for agents and organizations, membership
-- identities, organization groups and administration operations.
--
-- Agents and organizations are tombstoned, never hard-deleted. A deleted agent
-- keeps its last display name so history can still name it. Revisions count
-- changes for clients that merge directory events.
CREATE TABLE kipster.agents (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  display_name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  provisioned boolean NOT NULL DEFAULT false,
  learning_enabled boolean NOT NULL DEFAULT true,
  learning_revision bigint NOT NULL DEFAULT 0 CHECK (learning_revision >= 0),
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','archived','deleting','deleted')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT agents_deleted_at CHECK ((lifecycle = 'deleted') = (deleted_at IS NOT NULL)),
  sleep_time time(0),
  -- A settings revision counts settings changes separately from the directory revision.
  settings_revision bigint NOT NULL DEFAULT 1 CHECK (settings_revision >= 1)
);

CREATE TABLE kipster.agent_roles (
  agent_id uuid NOT NULL REFERENCES kipster.agents(id),
  role text NOT NULL,
  PRIMARY KEY (agent_id, role)
);

CREATE TABLE kipster.organizations (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  display_name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  provisioned boolean NOT NULL DEFAULT false,
  lifecycle text NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','deleting','deleted')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT organizations_deleted_at CHECK ((lifecycle = 'deleted') = (deleted_at IS NOT NULL)),
  settings_revision bigint NOT NULL DEFAULT 1 CHECK (settings_revision >= 1)
);

CREATE TABLE kipster.human_memberships (
  organization_id uuid NOT NULL REFERENCES kipster.organizations(id),
  person_id uuid NOT NULL REFERENCES kipster.people(id),
  PRIMARY KEY (organization_id, person_id)
);

-- A membership has its own identity so group appearances can reference it.
-- Removing a membership deletes the row; adding the agent again creates a new one.
CREATE TABLE kipster.agent_memberships (
  organization_id uuid NOT NULL REFERENCES kipster.organizations(id),
  agent_id uuid NOT NULL REFERENCES kipster.agents(id),
  PRIMARY KEY (organization_id, agent_id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_memberships_id UNIQUE (id),
  CONSTRAINT agent_memberships_id_organization UNIQUE (id, organization_id)
);

CREATE TABLE kipster.bootstrap (
  installation_id uuid PRIMARY KEY REFERENCES kipster.installations(id),
  owner_id uuid NOT NULL REFERENCES kipster.people(id),
  initial_organization_id uuid NOT NULL REFERENCES kipster.organizations(id),
  root_agent_id uuid NOT NULL REFERENCES kipster.agents(id)
);

-- Whether an owner may receive new work: provisioned and active. These helpers do not lock:
-- a writer that relies on the answer must lock the owner row itself.
CREATE FUNCTION kipster.live_agent(agent uuid) RETURNS boolean LANGUAGE sql STABLE
  RETURN /* live rule */ EXISTS (SELECT 1 FROM kipster.agents WHERE id = agent AND provisioned AND lifecycle = 'active');

CREATE FUNCTION kipster.live_organization(organization uuid) RETURNS boolean LANGUAGE sql STABLE
  RETURN /* live rule */ EXISTS (SELECT 1 FROM kipster.organizations WHERE id = organization AND provisioned AND lifecycle = 'active');

-- The live rule: an agent or organization takes new work only while it is provisioned and
-- active. Writers lock the owner row FOR KEY SHARE and then test it with these helpers; a
-- lifecycle change locks the row FOR UPDATE, so each write lands before the change or not at all.
COMMENT ON FUNCTION kipster.live_agent(uuid) IS 'Provisioned and active. Lock the agent row FOR KEY SHARE before relying on the answer.';

COMMENT ON FUNCTION kipster.live_organization(uuid) IS 'Provisioned and active. Lock the organization row FOR KEY SHARE before relying on the answer.';

-- Work ----------------------------------------------------------------------

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

-- Conversations -------------------------------------------------------------

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
  created_at timestamptz NOT NULL DEFAULT now()
);

-- `progress` marks a kip's progress note, written while it works, as opposed to its answer.
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
  UNIQUE (source_attempt_id, publication_source, publication_id),
  progress boolean NOT NULL DEFAULT false,
  finished_at timestamptz
);

-- `viewing_organization_id` is the workspace the person had open when they sent the message that
-- started the run. The admin kip reads it to act in that workspace. It stays a plain ID: the
-- workspace may be deleted later, and the run then simply has none.
--
-- `trigger_kind` is what started the run: a person's message, a kip's message or a kip's answer.
-- A person's run starts a chain at depth 0; runs started by its messages and answers share its
-- chain and its responsible person. `answered_at` is set once the answer of a kip-started run went
-- back, or could not.
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
  cancel_delivery text NOT NULL DEFAULT 'none' CHECK (cancel_delivery IN ('none','requested','acknowledged','uncertain','confirmed-ended','not-needed')),
  viewing_organization_id uuid,
  trigger_kind text NOT NULL DEFAULT 'person' CHECK (trigger_kind IN ('person','kip','answer')),
  chain_root_id uuid NOT NULL,
  chain_depth integer NOT NULL DEFAULT 0 CHECK (chain_depth BETWEEN 0 AND 16),
  responsible_person_id uuid NOT NULL REFERENCES kipster.people(id),
  answered_at timestamptz
);

CREATE INDEX text_runs_chain ON kipster.text_runs(chain_root_id) WHERE trigger_kind='answer';

-- This row is the shared admission lock for text and memory work. `update_request_id` gates
-- admission across Core restarts until the updater reports a terminal result.
CREATE TABLE kipster.execution_permits (
  installation_id uuid PRIMARY KEY REFERENCES kipster.installations(id),
  ceiling integer NOT NULL DEFAULT 20 CHECK (ceiling BETWEEN 1 AND 1000),
  delegation_depth_limit integer NOT NULL DEFAULT 4 CHECK (delegation_depth_limit BETWEEN 1 AND 16),
  delegation_root_budget integer NOT NULL DEFAULT 32 CHECK (delegation_root_budget BETWEEN 1 AND 1000),
  delegation_fanout_limit integer NOT NULL DEFAULT 4 CHECK (delegation_fanout_limit BETWEEN 1 AND 32),
  update_request_id text
);

CREATE TABLE kipster.owned_permits (
  attempt_id uuid PRIMARY KEY REFERENCES kipster.attempts(id),
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  acquired_at timestamptz NOT NULL DEFAULT now()
);

-- Work coordination ---------------------------------------------------------

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

-- An approval card a provider raised can offer a grant (`grant_offer`): a key its adapter defines
-- and later matches, and a label.
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
  UNIQUE (attempt_id,call_id),
  grant_offer jsonb
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

CREATE INDEX interactions_run_state ON kipster.interactions(run_id,state);

-- Kip messaging -------------------------------------------------------------

-- One linked thread per source thread and recipient kip, in the recipient's chat.
CREATE TABLE kipster.kip_links (
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  source_thread_id uuid NOT NULL REFERENCES kipster.threads(id),
  recipient_agent_id uuid NOT NULL REFERENCES kipster.agents(id),
  linked_thread_id uuid NOT NULL UNIQUE REFERENCES kipster.threads(id),
  sender_agent_id uuid NOT NULL REFERENCES kipster.agents(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, source_thread_id, recipient_agent_id)
);

CREATE INDEX kip_links_source ON kipster.kip_links(source_thread_id);

-- A `message_kip` call and its result, so a replayed call returns the first result and sends nothing new.
CREATE TABLE kipster.kip_message_calls (
  attempt_id uuid NOT NULL REFERENCES kipster.attempts(id),
  call_id text NOT NULL,
  sender_run_id uuid NOT NULL REFERENCES kipster.text_runs(id),
  chain_root_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (attempt_id, call_id)
);

CREATE INDEX kip_message_calls_sender ON kipster.kip_message_calls(sender_run_id);

CREATE INDEX kip_message_calls_chain ON kipster.kip_message_calls(chain_root_id);

-- Synchronization -----------------------------------------------------------

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
  revision bigint NOT NULL DEFAULT 1,
  -- A cleared notification is gone for clients; the row stays so it keeps its identity and is never created again.
  cleared_at timestamptz
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

-- Artifacts -----------------------------------------------------------------

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

-- Files an execution attaches by path to one message, one row per file in call order.
CREATE TABLE kipster.artifact_file_attachments (
  attempt_id uuid NOT NULL REFERENCES kipster.attempts(id),
  call_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  request_sha256 text NOT NULL,
  artifact_id uuid NOT NULL REFERENCES kipster.artifacts(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('staging','ready','failed')),
  PRIMARY KEY (attempt_id,call_id,ordinal)
);

CREATE INDEX artifact_recovery ON kipster.artifacts(state) WHERE state <> 'ready';

-- Voice ---------------------------------------------------------------------

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

-- Structured task data ------------------------------------------------------

CREATE SCHEMA task_data;

REVOKE ALL ON SCHEMA task_data FROM PUBLIC;

CREATE TABLE task_data.database_identity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  id uuid NOT NULL
);

CREATE TABLE task_data.namespaces (
  owner_kind text NOT NULL CHECK (owner_kind IN ('agent','organization')),
  owner_id uuid NOT NULL,
  schema_name name NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_kind,owner_id)
);

CREATE TABLE task_data.receipts (
  attempt_id uuid NOT NULL,
  call_id text NOT NULL,
  actor_id uuid NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('agent','organization')),
  owner_id uuid NOT NULL,
  operation text NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (attempt_id, call_id)
);

-- This function is the only Core privilege given to the task-data login. Its
-- row locks and the task mutation share one transaction and one backend.
-- Task data follows the live rule and runs in the run's own thread. The owners are locked FOR KEY
-- SHARE after the capacity lock and before the thread and run rows, the same order as every other
-- writer. The acting agent's membership is locked too, so a membership removal waits for the write
-- or refuses it. The admin kip may use any live workspace's task data without a membership or that
-- workspace as its context.
CREATE FUNCTION task_data.guard_attempt(
  p_attempt uuid, p_incarnation uuid, p_generation bigint,
  p_kind text, p_owner uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_installation uuid;
  v_thread uuid;
  v_run uuid;
  v_context_kind text;
  v_context_id uuid;
  v_actor uuid;
  v_admin boolean;
BEGIN
  SELECT c.installation_id, r.thread_id, r.id, c.context_kind, c.context_id, c.agent_id,
         EXISTS (SELECT 1 FROM kipster.agent_roles x WHERE x.agent_id=c.agent_id AND x.role='root-admin')
    INTO v_installation, v_thread, v_run, v_context_kind, v_context_id, v_actor, v_admin
    FROM kipster.attempts a
    JOIN kipster.text_runs r ON r.id=a.intent_id
    JOIN kipster.threads t ON t.id=r.thread_id
    JOIN kipster.direct_chats c ON c.id=t.chat_id
    WHERE a.id=p_attempt;
  IF v_installation IS NULL THEN RAISE EXCEPTION 'Unknown task-data attempt'; END IF;

  PERFORM 1 FROM kipster.execution_permits WHERE installation_id=v_installation FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing execution guard'; END IF;

  PERFORM 1 FROM kipster.agents WHERE id=v_actor AND installation_id=v_installation FOR KEY SHARE;
  IF NOT FOUND OR NOT kipster.live_agent(v_actor) THEN RAISE EXCEPTION 'Acting agent unavailable'; END IF;
  IF p_kind='agent' THEN
    PERFORM 1 FROM kipster.agents WHERE id=p_owner AND installation_id=v_installation FOR KEY SHARE;
    IF NOT FOUND OR NOT kipster.live_agent(p_owner) THEN RAISE EXCEPTION 'Task-data owner unavailable'; END IF;
  ELSIF p_kind='organization' THEN
    IF NOT v_admin AND (v_context_kind<>'organization' OR v_context_id<>p_owner) THEN
      RAISE EXCEPTION 'Organization target unavailable in this context';
    END IF;
    PERFORM 1 FROM kipster.organizations WHERE id=p_owner AND installation_id=v_installation FOR KEY SHARE;
    IF NOT FOUND OR NOT kipster.live_organization(p_owner) THEN RAISE EXCEPTION 'Task-data organization unavailable'; END IF;
    IF NOT v_admin THEN
      PERFORM 1 FROM kipster.agent_memberships
        WHERE organization_id=p_owner AND agent_id=v_actor FOR KEY SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Acting agent is not an organization member'; END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'Invalid task-data owner kind';
  END IF;

  PERFORM 1 FROM kipster.threads WHERE id=v_thread FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing run thread'; END IF;
  PERFORM 1 FROM kipster.text_runs r
    JOIN kipster.work_intents i ON i.id=r.id
    JOIN kipster.attempts a ON a.id=p_attempt AND a.intent_id=i.id
    WHERE r.id=v_run AND r.thread_id=v_thread AND r.current_attempt_id=p_attempt
      AND r.state='running' AND r.stop_requested=false
      AND i.state='issued' AND i.generation=p_generation
      AND a.state='issued' AND a.generation=p_generation
      AND a.incarnation=p_incarnation FOR UPDATE OF r,i,a;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attempt no longer owns task data'; END IF;
  RETURN v_actor;
END $$;

REVOKE ALL ON FUNCTION task_data.guard_attempt(uuid,uuid,bigint,text,uuid) FROM PUBLIC;

INSERT INTO task_data.database_identity(singleton,id) VALUES (true,pg_catalog.gen_random_uuid());

REVOKE ALL ON task_data.database_identity FROM PUBLIC;

REVOKE ALL ON task_data.namespaces FROM PUBLIC;

REVOKE ALL ON task_data.receipts FROM PUBLIC;

-- Vectors -------------------------------------------------------------------

CREATE TABLE kipster.vector_collections (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  owner_kind text NOT NULL CHECK (owner_kind IN ('agent','organization')),
  owner_id uuid NOT NULL,
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{0,39}$'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id,owner_kind,owner_id,name)
);

CREATE TABLE kipster.vector_records (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL REFERENCES kipster.vector_collections(id) ON DELETE CASCADE,
  record_key text NOT NULL CHECK (length(record_key) BETWEEN 1 AND 100),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 8192),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  source_hash text NOT NULL,
  source_bytes integer NOT NULL CHECK (source_bytes > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id,record_key)
);

CREATE TABLE kipster.vector_sources (
  record_id uuid NOT NULL REFERENCES kipster.vector_records(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 1),
  text text NOT NULL,
  metadata jsonb NOT NULL,
  source_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(record_id,revision)
);

CREATE TABLE kipster.vector_index_intents (
  record_id uuid NOT NULL,
  source_revision integer NOT NULL,
  source_hash text NOT NULL,
  generation bigint NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','processing','ready','failed','stale')),
  failure text,
  embedding vector,
  dimension integer,
  lease_owner uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(record_id,source_revision,generation),
  FOREIGN KEY(record_id,source_revision) REFERENCES kipster.vector_sources(record_id,revision) ON DELETE CASCADE
);

CREATE TABLE kipster.vector_tool_receipts (
  attempt_id uuid NOT NULL REFERENCES kipster.attempts(id),
  call_id text NOT NULL CHECK (length(call_id) BETWEEN 1 AND 200),
  operation text NOT NULL,
  arguments_hash text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(attempt_id,call_id)
);

CREATE INDEX vector_collections_owner ON kipster.vector_collections(installation_id,owner_kind,owner_id,name,id);

CREATE INDEX vector_records_collection ON kipster.vector_records(collection_id,id);

CREATE INDEX vector_intents_pending ON kipster.vector_index_intents(status,next_attempt_at,updated_at) WHERE status IN ('pending','processing','failed');

-- The installation's embedding profile; vector collections are indexed with it.
CREATE TABLE kipster.embedding_profiles (
  installation_id uuid PRIMARY KEY REFERENCES kipster.installations(id),
  provider text NOT NULL,
  model text NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  dimension integer,
  CHECK (generation > 0),
  CHECK (dimension IS NULL OR dimension > 0)
);

CREATE TABLE kipster.embedding_generations (
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  generation bigint NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  dimension integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(installation_id,generation)
);

-- Kip memory (decision record 10) ---------------------------------------------

-- How far the nightly run has processed each thread, by message position.
CREATE TABLE kipster.memory_thread_state (
  thread_id uuid PRIMARY KEY REFERENCES kipster.threads(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  processed_position bigint NOT NULL DEFAULT 0 CHECK (processed_position >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Searchable full-text pieces of a thread, private to the agent the thread
-- belongs to. Rows are saved first and embedded later; every embedding names
-- its model. started_at and ended_at are the times of the chunk's first and
-- last messages, for date-range search.
CREATE TABLE kipster.thread_chunks (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  thread_id uuid NOT NULL REFERENCES kipster.threads(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES kipster.agents(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES kipster.organizations(id) ON DELETE CASCADE,
  from_position bigint NOT NULL CHECK (from_position >= 1),
  to_position bigint NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  title text NOT NULL,
  text text NOT NULL CHECK (text <> ''),
  embedding vector(768),
  embedding_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (to_position >= from_position),
  CHECK (ended_at >= started_at),
  CHECK (embedding IS NULL OR embedding_model IS NOT NULL),
  UNIQUE (thread_id, from_position)
);

-- Facts about the user, shared by every agent of the installation. A card
-- learned in an organization thread carries that organization. A replaced
-- card keeps its row, ends at valid_to and names its replacement.
CREATE TABLE kipster.cards (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  type text NOT NULL CHECK (type <> ''),
  subject text NOT NULL CHECK (subject <> ''),
  statement text NOT NULL CHECK (statement <> ''),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  confirmed boolean NOT NULL DEFAULT false,
  core boolean NOT NULL DEFAULT false,
  organization_id uuid REFERENCES kipster.organizations(id) ON DELETE CASCADE,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  replaced_by uuid REFERENCES kipster.cards(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  embedding vector(768),
  embedding_model text,
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK (embedding IS NULL OR embedding_model IS NOT NULL)
);

-- The user messages each card was learned from. A card left with no source is
-- deleted with the thread that removed its last one.
CREATE TABLE kipster.card_sources (
  card_id uuid NOT NULL REFERENCES kipster.cards(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  thread_id uuid NOT NULL REFERENCES kipster.threads(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES kipster.messages(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, message_id)
);

-- One page per agent, day and context: a short summary and its threads. The
-- context is one organization, or none for installation threads. Search shows
-- a page only where the thread chunks of its context may be seen, so no page
-- mixes contexts. A null summary means the page owes a rebuild: a thread it
-- covered was deleted, and the next nightly run writes it again from the
-- remaining threads. Such a page has no embedding and is never searched.
CREATE TABLE kipster.diary (
  agent_id uuid NOT NULL REFERENCES kipster.agents(id) ON DELETE CASCADE,
  day date NOT NULL,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  summary text CHECK (summary <> ''),
  thread_ids uuid[] NOT NULL DEFAULT '{}',
  embedding vector(768),
  embedding_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (embedding IS NULL OR embedding_model IS NOT NULL),
  organization_id uuid REFERENCES kipster.organizations(id) ON DELETE CASCADE,
  CONSTRAINT diary_page UNIQUE NULLS NOT DISTINCT (agent_id, day, organization_id),
  CONSTRAINT diary_owed_unembedded CHECK (summary IS NOT NULL OR embedding IS NULL)
);

CREATE INDEX thread_chunks_embedding ON kipster.thread_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX cards_embedding ON kipster.cards USING hnsw (embedding vector_cosine_ops);
CREATE INDEX diary_embedding ON kipster.diary USING hnsw (embedding vector_cosine_ops);

CREATE INDEX thread_chunks_agent ON kipster.thread_chunks(agent_id, started_at);
CREATE INDEX thread_chunks_organization ON kipster.thread_chunks(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX thread_chunks_installation_day ON kipster.thread_chunks(installation_id, started_at);
CREATE INDEX thread_chunks_unembedded ON kipster.thread_chunks(installation_id) WHERE embedding IS NULL;
CREATE INDEX cards_current ON kipster.cards(installation_id, organization_id) WHERE valid_to IS NULL;
CREATE INDEX cards_core ON kipster.cards(installation_id) WHERE valid_to IS NULL AND core;
CREATE INDEX cards_organization ON kipster.cards(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX cards_replaced_by ON kipster.cards(replaced_by) WHERE replaced_by IS NOT NULL;
CREATE INDEX cards_unembedded ON kipster.cards(installation_id) WHERE embedding IS NULL;
CREATE INDEX card_sources_thread ON kipster.card_sources(thread_id);
CREATE INDEX card_sources_message ON kipster.card_sources(message_id);
CREATE INDEX diary_installation_day ON kipster.diary(installation_id, day);
CREATE INDEX diary_threads ON kipster.diary USING gin (thread_ids);
CREATE INDEX diary_unembedded ON kipster.diary(installation_id) WHERE embedding IS NULL;
CREATE INDEX diary_organization ON kipster.diary(organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX diary_owed ON kipster.diary(agent_id) WHERE summary IS NULL;

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

-- Settings ------------------------------------------------------------------

-- The execution adapters the running dispatcher has, with their availability and
-- catalogs. The dispatcher replaces the list when it changes and bumps the revision.
CREATE TABLE kipster.execution_adapters (
  installation_id uuid PRIMARY KEY REFERENCES kipster.installations(id),
  revision bigint NOT NULL CHECK (revision >= 0),
  adapters jsonb NOT NULL
);

-- Installation-wide interface choices every connected interface applies. A missing value
-- (NULL) leaves the interface default. The revision counts changes. Next to the desktop
-- alert choice: which desktop alerts to show, in-app banners and the app icon badge.
CREATE TABLE kipster.interface_preferences (
  installation_id uuid PRIMARY KEY REFERENCES kipster.installations(id),
  revision bigint NOT NULL CHECK (revision >= 0),
  palette text,
  theme text,
  desktop_notifications boolean,
  notify_needs boolean,
  notify_failures boolean,
  notify_replies boolean,
  in_app_banners boolean,
  dock_badge boolean
);

-- What kips may do without asking, for the whole installation. Without a row the mode is `auto`.
-- A per-agent override can later add its own nullable column or table that falls back to this one.
CREATE TABLE kipster.permission_settings (
  installation_id uuid PRIMARY KEY REFERENCES kipster.installations(id),
  revision bigint NOT NULL CHECK (revision >= 0),
  mode text NOT NULL DEFAULT 'auto' CHECK (mode IN ('supervised', 'acceptEdits', 'auto', 'fullAccess'))
);

-- Actions the person allowed beyond one card. A thread grant covers that conversation; a grant without a thread
-- covers every kip of the installation until the person removes it.
CREATE TABLE kipster.approval_grants (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  thread_id uuid REFERENCES kipster.threads(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 500),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX approval_grants_always ON kipster.approval_grants(installation_id, key) WHERE thread_id IS NULL;
CREATE UNIQUE INDEX approval_grants_thread ON kipster.approval_grants(thread_id, key) WHERE thread_id IS NOT NULL;

-- Administration ------------------------------------------------------------

-- Visual groups belong to an organization. An appearance places one membership
-- in one group; an agent may appear in several groups of the same organization.
CREATE TABLE kipster.groups (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES kipster.organizations(id),
  name text NOT NULL CHECK (length(name) > 0),
  position integer NOT NULL CHECK (position >= 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, organization_id)
);

CREATE TABLE kipster.group_appearances (
  group_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (group_id, membership_id),
  FOREIGN KEY (group_id, organization_id) REFERENCES kipster.groups(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (membership_id, organization_id) REFERENCES kipster.agent_memberships(id, organization_id) ON DELETE CASCADE
);

-- One record per administration request, keyed by the caller's operation ID so
-- a repeated request returns the recorded outcome.
CREATE TABLE kipster.admin_operations (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('person','agent')),
  actor_id uuid NOT NULL,
  operation_id text NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 200),
  kind text NOT NULL,
  target_kind text,
  target_id uuid,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','waiting','succeeded','failed')),
  step text,
  result jsonb,
  error text,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, actor_kind, actor_id, operation_id),
  -- Why a running operation waits, for example for a provider that could still write.
  waiting_for text CHECK (waiting_for IS NULL OR length(waiting_for) <= 500),
  request jsonb NOT NULL,
  origin_run_id uuid
);

-- Core owns these immutable targets. Provider-authored proposal text cannot authorize a mutation.
-- Installation-wide actions (installing or restoring a Core version, giving kips full access,
-- installing a Kipster Plugins release) target the installation and keep their details in options.
CREATE TABLE kipster.admin_approvals (
  interaction_id uuid PRIMARY KEY REFERENCES kipster.interactions(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  action text NOT NULL,
  target_id uuid NOT NULL,
  target_name text NOT NULL,
  options jsonb NOT NULL,
  operation_id text NOT NULL,
  result jsonb,
  CONSTRAINT admin_approvals_action_check
    CHECK (action IN ('agent.archive','agent.delete','organization.delete','update.install','permissions.set','update.plugins-install'))
);

CREATE INDEX groups_organization ON kipster.groups(organization_id, position);

CREATE INDEX group_appearances_membership ON kipster.group_appearances(membership_id);

CREATE INDEX admin_operations_open ON kipster.admin_operations(installation_id) WHERE state IN ('pending','running','waiting');

CREATE INDEX admin_operations_origin ON kipster.admin_operations(installation_id, actor_id, origin_run_id, created_at);

-- Updates -------------------------------------------------------------------

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
  terminal boolean NOT NULL DEFAULT false,
  delivered_at timestamptz
);

-- Documents -----------------------------------------------------------------

-- Rich documents. A document lives in a context and has a home thread and a responsible agent.
-- Rows do not reference chats, threads or runs: removing a home thread removes its documents explicitly.
CREATE TABLE kipster.documents (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  context_kind text NOT NULL CHECK (context_kind IN ('installation','organization')),
  context_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  title text NOT NULL,
  turn text NOT NULL CHECK (turn IN ('user','agent')),
  turn_run_id uuid,
  -- The run whose turn the user took back; its later edits are refused.
  released_run_id uuid,
  current_revision integer NOT NULL CHECK (current_revision >= 1),
  draft_counter integer NOT NULL DEFAULT 0,
  revision bigint NOT NULL DEFAULT 1,
  created_attempt_id uuid,
  created_call_id text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((turn = 'agent') = (turn_run_id IS NOT NULL)),
  UNIQUE (created_attempt_id, created_call_id)
);
CREATE INDEX documents_installation ON kipster.documents(installation_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX documents_turn_run ON kipster.documents(turn_run_id) WHERE turn_run_id IS NOT NULL;
CREATE INDEX documents_thread ON kipster.documents(thread_id);
CREATE INDEX documents_context ON kipster.documents(context_kind, context_id);

-- Immutable snapshots; `changes` compares a revision with the one before it.
CREATE TABLE kipster.document_revisions (
  document_id uuid NOT NULL REFERENCES kipster.documents(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number >= 1),
  author_kind text NOT NULL CHECK (author_kind IN ('user','agent')),
  author_id uuid NOT NULL,
  title text NOT NULL,
  blocks jsonb NOT NULL,
  note text NOT NULL DEFAULT '',
  changes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, number)
);

-- The user's unsubmitted working copy.
CREATE TABLE kipster.document_drafts (
  document_id uuid PRIMARY KEY REFERENCES kipster.documents(id) ON DELETE CASCADE,
  draft_version integer NOT NULL CHECK (draft_version >= 1),
  base_revision integer NOT NULL,
  title text NOT NULL,
  blocks jsonb NOT NULL,
  comments jsonb NOT NULL,
  note text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kipster.document_comments (
  document_id uuid NOT NULL REFERENCES kipster.documents(id) ON DELETE CASCADE,
  id text NOT NULL,
  number integer NOT NULL CHECK (number >= 1),
  block_id text NOT NULL,
  field text NOT NULL,
  quote text NOT NULL,
  start_offset integer NOT NULL,
  end_offset integer NOT NULL,
  body text NOT NULL,
  state text NOT NULL CHECK (state IN ('open','resolved')),
  reply text,
  submitted_in_revision integer NOT NULL,
  resolved_in_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, id),
  UNIQUE (document_id, number)
);

-- An agent run's unpublished edits; they become one revision when the run ends.
CREATE TABLE kipster.document_working_copies (
  document_id uuid PRIMARY KEY REFERENCES kipster.documents(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  title text NOT NULL,
  blocks jsonb NOT NULL,
  resolutions jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Files any revision, draft or working copy referenced; they stay readable through the document.
CREATE TABLE kipster.document_artifacts (
  document_id uuid NOT NULL REFERENCES kipster.documents(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES kipster.artifacts(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, artifact_id)
);
CREATE INDEX document_artifacts_artifact ON kipster.document_artifacts(artifact_id);

CREATE TABLE kipster.document_submissions (
  installation_id uuid NOT NULL,
  caller_id uuid NOT NULL,
  operation_id text NOT NULL,
  document_id uuid NOT NULL REFERENCES kipster.documents(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  run_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, caller_id, operation_id)
);

-- Plugins -------------------------------------------------------------------

-- Core's copy of the tools of each plugin with an account, as the plugin server lists them, without the account
-- argument it adds. Kept while an account needs reconnecting; removed with the plugin's last account.
CREATE TABLE kipster.plugin_tools (
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  name text NOT NULL,
  plugin_id text NOT NULL,
  plugin_name text NOT NULL,
  title text,
  description text NOT NULL,
  input_schema jsonb NOT NULL,
  content_hash text NOT NULL,
  -- Meaning search; NULL until embedded with the installation's current embedding model.
  embedding vector,
  embedding_model text,
  search_text tsvector GENERATED ALWAYS AS (to_tsvector('simple', replace(name, '_', ' ') || ' ' || coalesce(title, '') || ' ' || description)) STORED,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, name)
);
CREATE INDEX plugin_tools_plugin ON kipster.plugin_tools(installation_id, plugin_id);
CREATE INDEX plugin_tools_search ON kipster.plugin_tools USING gin (search_text);

-- The exact plugin call an approval card asks about. Once approved, the same call in the same run runs once.
CREATE TABLE kipster.plugin_tool_approvals (
  interaction_id uuid PRIMARY KEY REFERENCES kipster.interactions(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  call_key text NOT NULL,
  used_at timestamptz
);
CREATE INDEX plugin_tool_approvals_run ON kipster.plugin_tool_approvals(run_id, call_key) WHERE used_at IS NULL;
