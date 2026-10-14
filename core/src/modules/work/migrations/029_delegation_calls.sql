-- A delegation call answered with the run's existing identical delegation keeps its call identity here,
-- so a replay of that call with other arguments is a conflict.
CREATE TABLE kipster.delegation_calls (
  attempt_id uuid NOT NULL REFERENCES kipster.attempts(id),
  call_id text NOT NULL,
  delegation_id uuid NOT NULL REFERENCES kipster.delegations(id) ON DELETE CASCADE,
  PRIMARY KEY (attempt_id,call_id)
);

CREATE INDEX delegation_calls_delegation ON kipster.delegation_calls(delegation_id);
