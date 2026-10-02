-- A cleared notification is gone for clients; the row stays so it keeps its identity and is never created again.
ALTER TABLE kipster.notifications ADD COLUMN cleared_at timestamptz;
