-- migrate:up
-- CLUSTOX: explicit, informational repo<->Jira-project pairing within a
-- team -- see docs/JIRA_MULTI_ACCOUNT_PLAN.md's follow-up on Jira<->repo
-- relationships. A team's TeamRepos and TeamProjects are two independent
-- flat lists today (a team just "tracks" some repos and some projects,
-- with no link between which repo goes with which project); once a team
-- has more than one of each, there is no way to say "this repo's tickets
-- come from this project" anywhere in the UI or data model.
--
-- Deliberately informational only, not a matching constraint: PR<->ticket
-- association (TicketMatchingService) keeps resolving purely from the
-- Jira issue key found in the PR title, exactly as already implemented
-- and tested -- this table has no foreign key from anywhere in that path
-- and nothing reads it during matching or sync. It exists so an admin can
-- record and see the pairing for organization/reporting purposes, without
-- touching the already-verified matching behavior.
--
-- team_id is included even though org_repo_id/org_project_id could in
-- principle resolve their own org unambiguously, because both TeamRepos
-- and TeamProjects are themselves team-scoped -- the same repo can be
-- tracked by two different teams, each potentially pairing it with a
-- different project, and this mirrors that shape rather than introducing
-- a single global repo->project pairing that would conflict with it.
CREATE TABLE "TeamRepoProjectMapping" (
  team_id        uuid NOT NULL REFERENCES "Team"(id),
  org_repo_id    uuid NOT NULL REFERENCES "OrgRepo"(id),
  org_project_id uuid NOT NULL REFERENCES "OrgProject"(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, org_repo_id, org_project_id)
);

CREATE INDEX team_repo_project_mapping_repo_index
  ON "TeamRepoProjectMapping" USING btree (team_id, org_repo_id);

CREATE INDEX team_repo_project_mapping_project_index
  ON "TeamRepoProjectMapping" USING btree (team_id, org_project_id);

-- migrate:down
DROP TABLE "TeamRepoProjectMapping";
