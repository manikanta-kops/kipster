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
CREATE TABLE kipster.admin_approvals (
  interaction_id uuid PRIMARY KEY REFERENCES kipster.interactions(id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES kipster.installations(id),
  action text NOT NULL CHECK (action IN ('agent.archive','agent.delete','organization.delete')),
  target_id uuid NOT NULL,
  target_name text NOT NULL,
  options jsonb NOT NULL,
  operation_id text NOT NULL,
  result jsonb
);

CREATE INDEX groups_organization ON kipster.groups(organization_id, position);

CREATE INDEX group_appearances_membership ON kipster.group_appearances(membership_id);

CREATE INDEX admin_operations_open ON kipster.admin_operations(installation_id) WHERE state IN ('pending','running','waiting');

CREATE INDEX admin_operations_origin ON kipster.admin_operations(installation_id, actor_id, origin_run_id, created_at);
