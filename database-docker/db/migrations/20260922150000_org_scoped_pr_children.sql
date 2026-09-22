-- migrate:up
-- CLUSTOX: third instance of the cross-org global-unique class (after
-- OrgRepo in 20260902090000, which made the same repo addable in two
-- workspaces). Once added, the second workspace's SYNC then failed one
-- layer down: PR events carried a global UNIQUE (idempotency_key) -- the
-- provider's event id, identical in every workspace's copy -- so saving
-- the second copy rolled back the whole repo batch, forever. Commits were
-- worse: PRIMARY KEY (hash) made session.merge silently STEAL the other
-- workspace's row instead of erroring. Both keys are now scoped to the
-- owning pull request. Ships with the model change that makes
-- SQLAlchemy's merge identity match; apply both together.
--
-- Existing data satisfies both new constraints (they are strictly weaker).
-- The commit PK addition requires pull_request_id NOT NULL; every writer
-- has always set it.
ALTER TABLE "PullRequestEvent"
  DROP CONSTRAINT "PullRequestEvent_idempotency_key_key";

ALTER TABLE "PullRequestEvent"
  ADD CONSTRAINT pr_event_idempotency_key_per_pr UNIQUE (pull_request_id, idempotency_key);

ALTER TABLE "PullRequestCommit"
  DROP CONSTRAINT "PullRequestCommit_pkey";

ALTER TABLE "PullRequestCommit"
  ADD CONSTRAINT "PullRequestCommit_pkey" PRIMARY KEY (pull_request_id, hash);

-- migrate:down
-- NOTE: restoring the global keys FAILS if two workspaces have since
-- synced the same repo -- the state the up-migration exists to allow.
ALTER TABLE "PullRequestCommit"
  DROP CONSTRAINT "PullRequestCommit_pkey";

ALTER TABLE "PullRequestCommit"
  ADD CONSTRAINT "PullRequestCommit_pkey" PRIMARY KEY (hash);

ALTER TABLE "PullRequestEvent"
  DROP CONSTRAINT pr_event_idempotency_key_per_pr;

ALTER TABLE "PullRequestEvent"
  ADD CONSTRAINT "PullRequestEvent_idempotency_key_key" UNIQUE (idempotency_key);
