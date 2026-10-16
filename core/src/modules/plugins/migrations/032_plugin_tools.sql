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
