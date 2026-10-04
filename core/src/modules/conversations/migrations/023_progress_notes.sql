-- A kip's progress note, written while it works, as opposed to its answer.
ALTER TABLE kipster.messages ADD COLUMN progress boolean NOT NULL DEFAULT false;
