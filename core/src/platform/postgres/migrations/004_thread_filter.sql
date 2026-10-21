-- Which threads a chat's feed shows, the same in every chat and window: all, those the person started, those other
-- kips started, or routine runs. NULL leaves the interface default, all threads.
ALTER TABLE kipster.interface_preferences
  ADD COLUMN thread_filter text CHECK (thread_filter IN ('all', 'you', 'kips', 'routines'));
