-- The admin agent may also ask the owner to approve installing or restoring a Core version.
-- The target is the installation; the version and backup are in options.
ALTER TABLE kipster.admin_approvals DROP CONSTRAINT admin_approvals_action_check;
ALTER TABLE kipster.admin_approvals ADD CONSTRAINT admin_approvals_action_check
  CHECK (action IN ('agent.archive','agent.delete','organization.delete','update.install'));
