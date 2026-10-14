-- The admin agent may also ask the owner to approve installing a Kipster Plugins release.
-- The target is the installation; the version is in options.
ALTER TABLE kipster.admin_approvals DROP CONSTRAINT admin_approvals_action_check;
ALTER TABLE kipster.admin_approvals ADD CONSTRAINT admin_approvals_action_check
  CHECK (action IN ('agent.archive','agent.delete','organization.delete','update.install','permissions.set','update.plugins-install'));
