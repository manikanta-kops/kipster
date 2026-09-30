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
-- Task data follows the live rule. The owners are locked FOR KEY SHARE after the capacity lock
-- and before the thread and run rows, the same order as every other writer. The acting agent's
-- membership is locked too, so a membership removal waits for the write or refuses it.
CREATE FUNCTION task_data.guard_attempt(
  p_attempt uuid, p_incarnation uuid, p_generation bigint,
  p_kind text, p_owner uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_installation uuid;
  v_thread uuid;
  v_root_thread uuid;
  v_run uuid;
  v_context_kind text;
  v_context_id uuid;
  v_actor uuid;
BEGIN
  SELECT c.installation_id, r.thread_id, COALESCE(d.origin_thread_id,r.thread_id),
         r.id,c.context_kind,c.context_id,COALESCE(d.recipient_agent_id,c.agent_id)
    INTO v_installation,v_thread,v_root_thread,v_run,v_context_kind,v_context_id,v_actor
    FROM kipster.attempts a
    JOIN kipster.text_runs r ON r.id=a.intent_id
    JOIN kipster.threads t ON t.id=r.thread_id
    JOIN kipster.direct_chats c ON c.id=t.chat_id
    LEFT JOIN kipster.delegations d ON d.child_run_id=r.id
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
    IF v_context_kind<>'organization' OR v_context_id<>p_owner THEN
      RAISE EXCEPTION 'Organization target unavailable in this context';
    END IF;
    PERFORM 1 FROM kipster.organizations WHERE id=p_owner AND installation_id=v_installation FOR KEY SHARE;
    IF NOT FOUND OR NOT kipster.live_organization(p_owner) THEN RAISE EXCEPTION 'Task-data organization unavailable'; END IF;
    PERFORM 1 FROM kipster.agent_memberships
      WHERE organization_id=p_owner AND agent_id=v_actor FOR KEY SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Acting agent is not an organization member'; END IF;
  ELSE
    RAISE EXCEPTION 'Invalid task-data owner kind';
  END IF;

  PERFORM 1 FROM kipster.threads WHERE id=v_root_thread FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing root thread'; END IF;
  IF v_thread<>v_root_thread THEN
    PERFORM 1 FROM kipster.threads WHERE id=v_thread FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Missing child thread'; END IF;
  END IF;
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
