-- migrate:up
-- CLUSTOX: which single Jira project (if any) a repo's tickets should be
-- matched against -- see docs/JIRA_INTEGRATION_PROPOSAL.md. Until now a
-- team's repos and its Jira projects were two independent lists with no
-- recorded relationship, so ticket matching fell back to scanning every
-- ticket key in the whole org against every PR, regardless of repo.
--
-- org_repo_id is the sole primary key, not composite with
-- org_project_id like TeamRepos/TeamProjects are -- a repo maps to at
-- most one project by design, enforced here at the schema level, not
-- just in application code. A project can still have many repos (no
-- uniqueness constraint on org_project_id).
--
-- No is_active column: nothing else references this table's rows by
-- FK, and a stale mapping serves no purpose once a repo is remapped or
-- unmapped, so unmapping is a real DELETE, not a soft one.
CREATE TABLE "RepoProjectMapping" (
  org_repo_id      uuid PRIMARY KEY REFERENCES "OrgRepo"(id),
  org_project_id   uuid NOT NULL REFERENCES "OrgProject"(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX repo_project_mapping_project_fetch_index
  ON "RepoProjectMapping" USING btree (org_project_id);

-- migrate:down
DROP TABLE "RepoProjectMapping";
