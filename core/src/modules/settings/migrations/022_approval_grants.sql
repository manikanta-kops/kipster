-- An approval card a provider raised can offer a grant: a key its adapter defines and later matches, and a label.
ALTER TABLE kipster.interactions ADD COLUMN grant_offer jsonb;

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
