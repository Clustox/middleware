-- migrate:up
-- CLUSTOX: Jira multi-account support -- see docs/JIRA_MULTI_ACCOUNT_PLAN.md.
--
-- Deliberately NOT touching "Integration": that table's PK is
-- (org_id, name), i.e. one row per provider per org, which is exactly the
-- single-Jira-account limitation this feature lifts. Rather than widen an
-- existing, shared-across-providers table (GitHub/GitLab/Jenkins all rely
-- on that same singleton shape), "JiraConnection" is a new, Jira-only,
-- surrogate-keyed table: many rows per org, one per connected Jira site+
-- account. The legacy "Integration" row (name='jira') is left completely
-- alone and keeps working for orgs that haven't linked a JiraConnection --
-- there is deliberately no migration/sync between the two tables.
CREATE TABLE "JiraConnection" (
  id                       uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  org_id                   uuid NOT NULL REFERENCES "Organization"(id),
  -- Normalized host, e.g. "acme.atlassian.net" -- no scheme/trailing slash.
  site_url                 varchar NOT NULL,
  email                    varchar NOT NULL,
  access_token_enc_chunks  varchar[],
  provider_meta            jsonb,
  is_default               boolean NOT NULL DEFAULT false,
  generated_by             uuid REFERENCES "Users"(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- (org_id, site_url) alone would block a legitimate case: two different
-- Jira accounts (different emails) both linking the same site. Including
-- email keeps that possible while still preventing the same account being
-- linked twice.
CREATE UNIQUE INDEX jira_connection_unique_account
  ON "JiraConnection"(org_id, site_url, email);

-- Enforced at the DB level, not just app code -- app-level races (two
-- concurrent "set as default" requests) would otherwise be able to leave
-- an org with zero or two default connections.
CREATE UNIQUE INDEX jira_connection_one_default_per_org
  ON "JiraConnection"(org_id) WHERE is_default;

CREATE INDEX jira_connection_org_fetch_index
  ON "JiraConnection" USING btree (org_id);

-- Records which JiraConnection a given synced OrgProject came from. A new
-- join table rather than a column on "OrgProject" itself, so "OrgProject"
-- (and everything that already reads it -- TeamProjects, Ticket, sync
-- bookmarks) stays completely unchanged. A row's absence here means the
-- project was synced by the legacy single-Jira-account flow (Integration),
-- not a JiraConnection -- callers should treat "no row" as "the org's
-- legacy/default Jira", not as an error.
CREATE TABLE "OrgProjectConnection" (
  org_project_id     uuid PRIMARY KEY REFERENCES "OrgProject"(id),
  jira_connection_id uuid NOT NULL REFERENCES "JiraConnection"(id),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX org_project_connection_connection_index
  ON "OrgProjectConnection" USING btree (jira_connection_id);

-- migrate:down
DROP TABLE "OrgProjectConnection";
DROP TABLE "JiraConnection";
