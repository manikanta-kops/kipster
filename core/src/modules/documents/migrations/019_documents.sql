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
