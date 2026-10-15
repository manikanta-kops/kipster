ALTER TABLE kipster.messages ADD COLUMN finished_at timestamptz;

UPDATE kipster.messages SET finished_at = created_at WHERE final = true;

-- Retained replay must carry the same additive fields as fresh messages.
-- A historical draft stays a draft even if its canonical message is now final.
UPDATE kipster.thread_events e
SET data = e.data || jsonb_build_object(
  'createdAt', to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
) || CASE WHEN e.type = 'message-final' THEN jsonb_build_object(
  'finishedAt', to_char(COALESCE(m.finished_at, e.occurred_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
) ELSE '{}'::jsonb END
FROM kipster.messages m
WHERE e.resource_id = m.id AND e.type IN ('message-draft', 'message-final');
