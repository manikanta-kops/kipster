ALTER TABLE kipster.update_requests ADD COLUMN delivered_at timestamptz;

-- Older delivered requests must also have a restart-safe pickup deadline.
UPDATE kipster.update_requests SET delivered_at=(request->>'requestedAt')::timestamptz WHERE delivered;
