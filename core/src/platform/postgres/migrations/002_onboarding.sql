-- When the person finished first-run onboarding; null until then. Set once.
ALTER TABLE kipster.installations ADD COLUMN onboarding_completed_at timestamptz;
