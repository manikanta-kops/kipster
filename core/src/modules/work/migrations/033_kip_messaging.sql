-- Kip messaging (decision record 11) replaces hidden delegation: kips message each other in visible linked
-- threads, and answers come back into the thread the message came from.
DROP TABLE kipster.delegation_calls;

DROP TABLE kipster.delegations;

ALTER TABLE kipster.threads DROP COLUMN internal;

-- What started each run: a person's message, a kip's message or a kip's answer. A person's run starts a chain at
-- depth 0; runs started by its messages and answers share its chain and its responsible person. `answered_at` is set
-- once the answer of a kip-started run went back, or could not.
ALTER TABLE kipster.text_runs
  ADD COLUMN trigger_kind text NOT NULL DEFAULT 'person' CHECK (trigger_kind IN ('person','kip','answer')),
  ADD COLUMN chain_root_id uuid,
  ADD COLUMN chain_depth integer NOT NULL DEFAULT 0 CHECK (chain_depth BETWEEN 0 AND 16),
  ADD COLUMN responsible_person_id uuid REFERENCES kipster.people(id),
  ADD COLUMN answered_at timestamptz;

UPDATE kipster.text_runs r SET chain_root_id=r.id, responsible_person_id=c.caller_id
  FROM kipster.threads t JOIN kipster.direct_chats c ON c.id=t.chat_id WHERE t.id=r.thread_id;

ALTER TABLE kipster.text_runs ALTER COLUMN chain_root_id SET NOT NULL, ALTER COLUMN responsible_person_id SET NOT NULL;

CREATE INDEX text_runs_chain ON kipster.text_runs(chain_root_id) WHERE trigger_kind='answer';

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

-- Task data runs in the run's own thread now that no run executes for another agent. The admin kip may use any live
-- workspace's task data without a membership or that workspace as its context.
CREATE OR REPLACE FUNCTION task_data.guard_attempt(
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
