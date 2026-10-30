-- Recruiting: who brought each servant in, and whether the recruiter has been
-- paid the one-time bonus (on the recruit's first accepted task).
ALTER TABLE servants ADD COLUMN recruited_by TEXT;
ALTER TABLE servants ADD COLUMN referral_paid INTEGER NOT NULL DEFAULT 0;
CREATE INDEX servants_recruited_by ON servants (recruited_by);
