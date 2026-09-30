-- The execution adapters the running dispatcher has, with their availability and
-- catalogs. The dispatcher replaces the list when it changes and bumps the revision.
CREATE TABLE kipster.execution_adapters (
  installation_id uuid PRIMARY KEY REFERENCES kipster.installations(id),
  revision bigint NOT NULL CHECK (revision >= 0),
  adapters jsonb NOT NULL
);
