-- Learning switches. An agent learns only while both its installation switch
-- (off by default) and its own switch (on by default) are on. Revisions count
-- changes for clients that apply learning-changed events.
CREATE TABLE kipster.installations (
  id uuid PRIMARY KEY,
  singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  created_at timestamptz NOT NULL DEFAULT now(),
  learning_enabled boolean NOT NULL DEFAULT false,
  learning_revision bigint NOT NULL DEFAULT 0 CHECK (learning_revision >= 0),
  sleep_time time(0) NOT NULL DEFAULT '01:00'
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
