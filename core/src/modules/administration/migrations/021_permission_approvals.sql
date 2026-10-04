-- The admin agent asks the owner to approve giving kips full access. The target is the installation;
-- the requested mode is in options.
ALTER TABLE kipster.admin_approvals DROP CONSTRAINT admin_approvals_action_check;
ALTER TABLE kipster.admin_approvals ADD CONSTRAINT admin_approvals_action_check
  CHECK (action IN ('agent.archive','agent.delete','organization.delete','update.install','permissions.set'));
