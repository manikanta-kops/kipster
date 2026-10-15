-- The workspace the person had open when they sent the message that started a run. The admin kip reads it to act
-- in that workspace. It stays a plain ID: the workspace may be deleted later, and the run then simply has none.
ALTER TABLE kipster.text_runs ADD COLUMN viewing_organization_id uuid;
