-- A kip reaches the person only with `message_user` (decision record 12). A message with normal priority notifies
-- once, with a `message` notification that names it; finished turns no longer notify.
ALTER TABLE kipster.notifications ADD COLUMN message_id uuid REFERENCES kipster.messages(id);
ALTER TABLE kipster.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE kipster.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN ('completed','failed','recovery-needed','interaction','message'));
ALTER TABLE kipster.notifications ADD CONSTRAINT notifications_message_check CHECK ((kind = 'message') = (message_id IS NOT NULL));

DROP INDEX kipster.notifications_terminal_identity;
CREATE UNIQUE INDEX notifications_terminal_identity ON kipster.notifications(run_id,kind) WHERE interaction_id IS NULL AND message_id IS NULL;
CREATE UNIQUE INDEX notifications_message_identity ON kipster.notifications(message_id) WHERE message_id IS NOT NULL;

-- A chain's budget counts its kip messages and answers as the runs they start.
DROP INDEX kipster.text_runs_chain;
CREATE INDEX text_runs_chain ON kipster.text_runs(chain_root_id) WHERE trigger_kind IN ('kip','answer');
