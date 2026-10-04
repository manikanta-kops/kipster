-- What kips may do without asking, for the whole installation. Without a row the mode is `auto`.
-- A per-agent override can later add its own nullable column or table that falls back to this one.
CREATE TABLE kipster.permission_settings (
  installation_id uuid PRIMARY KEY REFERENCES kipster.installations(id),
  revision bigint NOT NULL CHECK (revision >= 0),
  mode text NOT NULL DEFAULT 'auto' CHECK (mode IN ('supervised', 'acceptEdits', 'auto', 'fullAccess'))
);
