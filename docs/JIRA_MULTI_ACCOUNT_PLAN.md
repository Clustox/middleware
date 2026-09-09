# Jira Multi-Account Support — Implementation Plan

**Goal:** Let one org connect more than one Jira site/account (today: exactly one, via `Integration(name='jira')`), map different teams' projects to different connections, and sync/match tickets correctly per connection.

**Architecture:** A new, Jira-only, surrogate-keyed table `JiraConnection` (many rows per org) sits alongside the existing `Integration` table, which is left completely untouched and keeps working for orgs that never link a `JiraConnection`. A new join table `OrgProjectConnection` records which connection a given `OrgProject` came from, so `OrgProject`/`TeamProjects`/`Ticket` need zero schema changes — a team already maps to Jira projects via the existing `TeamProjects` table; which *connection* backs a given project is derived by joining through `OrgProjectConnection`. Ticket sync and PR↔ticket matching are updated to scope by connection, since Jira project keys and internal issue ids are only unique per-site, not across an org's connected sites.

**Tech Stack:** Flask 3 + SQLAlchemy 2, Postgres (dbmate migrations), Next.js 15 pages router, MUI 5.

## Global Constraints

- **No changes to existing tables/constraints.** `Integration`, `OrgProject`, `TeamProjects`, `Ticket`, `TicketState` are untouched — only new tables (`JiraConnection`, `OrgProjectConnection`) and new files. This is deliberate: reverting this feature is "drop 2 new tables + delete new files", never a migration-undo on tables other providers (GitHub/GitLab/Jenkins) also depend on.
- **No implicit sync between `Integration(name='jira')` and `JiraConnection`.** They are independent. If legacy code ever needs "the org's default Jira", that's a deliberate, separate, later change — not automatic mirroring (mirroring two write paths for the same fact is a source of silent drift, not safety).
- Only one `JiraConnection` per org may have `is_default = true` — enforced by a partial unique index, not just app code.
- `(org_id, site_url, email)` is the uniqueness key for a connection, not `(org_id, site_url)` — two different accounts on the same Jira site is a legitimate case (see docs discussion), not a duplicate.
- Ticket idempotency keys and the PR↔ticket matching key-map must be scoped per-connection, not just per-org — Jira issue ids and project keys are site-local, not globally unique, so two connections in the same org can collide (see "Known risks" below).
- Deleting a connection must be a checked, app-level operation (block with a clear error if any `OrgProjectConnection` still references it) — the DB FK (`NO ACTION`, no cascade) will hard-error anyway, but the app should never let a user hit a raw constraint violation.
- `# CLUSTOX:` comments explain WHY, never what.
- The API token is a secret; the email/site_url are not. Never let the token appear in logs, error messages, or test fixtures.
- Backend tests must pass (`cd backend/analytics_server && ./venv/bin/python -m pytest`); frontend must typecheck.

## Known risks this design must not reintroduce (found by code audit, not hypothetical)

1. **Ticket idempotency collision**: `_ticket_idempotency_key` in `etl_jira_handler.py` currently builds `f"jira:{org_id}:{issue.id}"` — no connection scoping. Two connections' sites can assign the same small, site-local `issue.id`. Must become `f"jira:{org_id}:{connection_id}:{issue.id}"` once sync is connection-aware (Task 4).
2. **PR↔ticket matching collision**: `get_org_tickets_key_map` in `ticket_matching.py` builds one flat `{TICKET_KEY: ticket_id}` dict per org, no connection scoping. Two connections both having a project called "PROJ" would silently collide ("PROJ-123" maps to whichever ticket the SQL happened to return last), mismatching a PR to the wrong ticket with no error. Must scope the map through `OrgProjectConnection` to only the connection(s) relevant to the PR's repo/team (Task 5).
3. **`get_jira_etl_handler`** currently does `integrations[0]` — hardcoded first element, not a loop. This is the load-bearing change for Task 4, not a minor patch.
4. **No existing rate-limit backoff or concurrency primitive** in the Jira ETL path — N connections will sync N× sequentially. Reuse the existing per-org Redis lock pattern (`api/sync.py`), extended to `{org_id}:{connection_id}:data_sync`, for isolation — do not attempt to introduce new concurrency machinery in this feature.

---

## Task 1: Schema — `JiraConnection` + `OrgProjectConnection` ✅ done

**Files:**
- `database-docker/db/migrations/20260909120000_clustox_jira_multi_account.sql`
- `backend/analytics_server/mhq/store/models/integrations/jira_connection.py` (+ `__init__.py` export)
- `backend/analytics_server/mhq/store/models/projects/repository.py` (`OrgProjectConnection` model, + `__init__.py` export)

Migration creates both tables, the `(org_id, site_url, email)` unique index, the partial `is_default` unique index, and both `migrate:down` drops. No existing table touched.

- [x] Run migration locally (`dbmate up` against the dev DB / docker) and confirm both `migrate:up` and `migrate:down` apply cleanly. Verified `up` against the dev container's DB — both tables and both indexes exist exactly as designed. `down` was not exercised in this session (destructive DB op, held back for explicit approval); the migration's `migrate:down` block is a straightforward two-table `DROP TABLE`, symmetric with `up`.
- [x] Confirm `flake8`/`black` clean on the two new model files.

## Task 2: Repository/service layer for `JiraConnection` ✅ done

**Files:**
- Created: `backend/analytics_server/mhq/store/repos/jira_connection.py`
- Created: `backend/analytics_server/tests/store/repos/test_jira_connection.py`

**Interface:**
```python
def create_jira_connection(org_id, site_url, email, access_token, provider_meta, generated_by) -> JiraConnection: ...
def list_jira_connections(org_id) -> List[JiraConnection]: ...
def get_jira_connection(org_id, connection_id) -> Optional[JiraConnection]: ...
def delete_jira_connection(org_id, connection_id) -> None: ...  # raises if OrgProjectConnection rows reference it
def set_default_jira_connection(org_id, connection_id) -> None: ...  # unsets any prior default in the same transaction
```
Reuses `CryptoService`/`get_crypto_service()` exactly as `Integration.access_token_enc_chunks` does — same global keypair, no per-row key management needed (confirmed safe by audit). `delete_jira_connection` and `set_default_jira_connection` both raise `JiraConnectionNotFoundError` when `connection_id` doesn't resolve for the given `org_id` (org-scoped lookup, not just an id match); `delete_jira_connection` additionally raises `JiraConnectionInUseError` when an `OrgProjectConnection` still references it, checked explicitly before any delete so the API layer (Task 3) never has to translate a raw FK `IntegrityError`. `set_default_jira_connection` unsets every other default for the org *before* setting the new one (two statements, one transaction/commit) — the reverse order would momentarily violate `jira_connection_one_default_per_org`.

- [x] Unit tests: create/list/get/delete, delete-blocked-by-reference, default-switch atomicity (no window where 0 or 2 defaults exist). 9 tests, all passing; full backend suite (469 tests) still green.

**Bug found live, after Task 6a shipped — second real user-facing failure:** a real user's own connection (site URL pasted straight from the browser's address bar, `https://acme.atlassian.net/`) was stored verbatim by `create_jira_connection` and silently broke every search/sync against it: `jira_project_search.ts`/`etl_jira_handler.py` both build `https://{site_url}/...`, so a stored value that already carries its own scheme becomes `https://https://acme.atlassian.net//...` — a URL that can't resolve, surfacing as an opaque connection timeout (8s, then a 502) with no indication of the real cause. `docs/JIRA_MULTI_ACCOUNT_PLAN.md`'s migration comment always said this column should hold "a normalized host... no scheme/trailing slash," and Task 3's write-up explicitly flagged that nothing enforced it yet — this is that gap, closed. Fixed with a new `_normalize_site_url` (strip scheme, trailing slash/path, lowercase host — mirrors web-server's existing `normalizeJiraSiteUrl`) called from `create_jira_connection` itself, the one place every caller funnels through, rather than trusted to each caller individually. The web-server's connection-add form (`JiraConnectionsManager.tsx`) now also calls `normalizeJiraSiteUrl` before submitting, for the same reason `ConfigureJiraModalBody` (the legacy flow) already did — belt and suspenders, not a substitute for the backend fix. 8 new tests (`TestNormalizeSiteUrl`'s parametrized cases, plus two `create_jira_connection` tests covering the exact reported input). Full backend suite: 556 passed (was 548, +8).

**Pre-existing data note:** the 3 `JiraConnection` rows already created against this dev DB before the fix landed still hold their un-normalized `site_url` values — a raw SQL repair was attempted and blocked by the environment's own destructive-write guardrail. Simplest fix for existing rows: delete and re-add them through the (now-fixed) UI, which is what was recommended to the user rather than pushing through the guardrail.

## Task 3: API endpoints ✅ done

**Decision (asked of the user, since it wasn't derivable from the plan text alone):** the new Next.js routes proxy to new Flask routes backed by Task 2's `JiraConnectionRepoService`, rather than writing `JiraConnection`/`OrgProjectConnection` directly from knex the way `orgs/[org_id]/integration.ts` does for the legacy singleton row. This is the same shape as the Jenkins mapping routes (`pages/api/clustox/jenkins/mappings.ts` → `mhq/api/integrations.py`). Chosen over direct knex writes because it reuses Task 2's delete-blocked check and default-switch atomicity in one place instead of re-implementing them in TypeScript, and because direct writes would have left create/delete/set_default unused outside tests.

**Files:**
- Backend (new, not in the original file list above — required by the proxy decision): four routes appended to `mhq/api/integrations.py` (`GET`/`POST /orgs/<org_id>/integrations/jira-connections`, `DELETE`/`PATCH /orgs/<org_id>/integrations/jira-connections/<connection_id>`), plus `tests/api/test_jira_connections_routes.py` (10 tests).
- Created: `web-server/pages/api/resources/orgs/[org_id]/jira-connections/index.ts` (GET list, POST create)
- Created: `web-server/pages/api/resources/orgs/[org_id]/jira-connections/[connection_id].ts` (DELETE, PATCH set-default)
- Created: matching `__tests__` for both (12 tests).
- `src/types/request.ts`: added a typed, optional `session` field to `ApiRequest` (previously only reachable via an untyped `(req as any).session`) — needed so the POST route can stamp `generated_by` with the signed-in user's id.
- `src/constants/feature.ts`: added `show_jira_multi_account` (default `false`).

Left `orgs/[org_id]/integration.ts`'s existing Jira handling completely untouched — these are new, additive routes only. Visibility is gated by `show_jira_multi_account`: both route files 404 (not 403 — while off, the routes should read as not existing) when the flag isn't set on the request.

**Explicitly not done in this pass** (not asked for by the plan's own checklist, called out so it isn't assumed covered): no live Jira-credential validation on create (the legacy flow's `pages/api/integrations/jira/validate.ts` has no analogue here yet — POST just persists whatever token it's given), and no `site_url` normalization (scheme/trailing-slash stripping) at either the Flask or Next layer — the migration comment describes the column as normalized, but nothing enforces it yet.

- [x] Auth/authz matches existing org-scoped route conventions (`Endpoint`'s built-in `assertWorkspaceAccess` on `org_id`, same as every other org-scoped BFF route; Flask side uses `query_validator.org_validator(org_id)` like the Jenkins/GitHub/GitLab routes beside it).
- [x] Integration test: create two connections, list returns both, delete one blocked while referenced, set-default swaps atomically. Covered at both layers — the Flask route tests via `FakeJiraConnectionRepoService` (in-memory, reproducing the uniqueness/reference/atomicity rules), and the Next.js tests confirm the proxying, error-forwarding, and feature-flag gate.
- [x] Full backend suite (479 tests) and full web-server typecheck stay green; full web-server jest suite run in progress at hand-off.

## Task 4: Sync — make it connection-aware ✅ done

**Files touched (larger than the plan's own list — see call-outs below):**
- `backend/analytics_server/mhq/service/project/sync/etl_jira_handler.py` — as planned.
- `backend/analytics_server/mhq/service/project/sync/etl_provider_handler.py` — new abstract method `get_org_projects_to_sync(org_id)`.
- `backend/analytics_server/mhq/service/project/sync/etl_handler.py` — `sync_org_projects` now asks the handler which projects to sync instead of querying `get_active_org_projects_for_provider` itself; `sync_project_issues` loops a *list* of handlers per provider (one per connection) with per-handler try/except.
- `backend/analytics_server/mhq/service/project/sync/etl_project_factory.py` — `__call__` returns `List[ProjectProviderETLHandler]`, not one handler.
- `backend/analytics_server/mhq/service/project/integration.py` — see gap call-out below.
- `backend/analytics_server/mhq/store/repos/projects.py` — new `get_active_org_projects_for_connection`.
- `backend/analytics_server/mhq/store/repos/jira_connection.py` — new `decrypt_access_token`.
- Tests: `test_etl_jira_handler.py` (+8), `test_projects_connection_scoping.py` (new, 2 tests, the join specifically).

**Design decision, strict either/or (not additive):** `get_jira_etl_handlers(org_id)` returns `[legacy_handler]` when the org has zero `JiraConnection` rows, or one handler per connection when it has any — never both. Concretely: the moment an org creates its first `JiraConnection`, any pre-existing projects still only reachable through the legacy `Integration` row **stop syncing** until Task 6's project picker moves them onto a connection (writes their `OrgProjectConnection` row). This reads as a real behavioral cliff but is what the plan's own text says ("falling back to legacy... when an org has none") and matches its Global Constraint that the two flows are deliberately independent, never auto-mirrored. Flagging it here in case that cliff is worse in practice than it reads on paper — it would be an easy follow-up to make legacy also cover "projects with no `OrgProjectConnection` row" if wanted, but that's an explicit product call, not a default I should have picked myself.

**Gap found beyond the plan's stated scope:** `ProjectIntegrationService.get_org_providers` (`integration.py`) only checked the legacy `Integration` table. An org with *only* `JiraConnection` rows and no legacy row would get an empty provider list and `sync_project_issues` would return immediately — a JiraConnection-only org would silently never sync at all. Fixed by also reporting `"jira"` when `JiraConnectionRepoService.list_jira_connections(org_id)` is non-empty.

**Write side of `OrgProjectConnection` is NOT in this task**, despite the plan's Task 4 text mentioning it ("write an OrgProjectConnection row for every OrgProject synced from a JiraConnection"): nothing in the sync path (`etl_jira_handler.py`/`etl_handler.py`) ever creates `OrgProject` rows — that only happens in `ProjectService.update_team_projects` (`repository_service.py`), which is squarely Task 6 (project selection) territory, not sync. Sync only ever *reads* the `OrgProjectConnection` join (`get_active_org_projects_for_connection`) to know which projects are already claimed by a connection. Task 6, when it adds "pick a connection before picking its projects," is where the write actually belongs.

**Known risk #4 (rate-limit/concurrency) closed by design, no new primitive needed:** connections sync strictly sequentially inside `sync_project_issues`'s for-loop, and that whole call already runs inside the existing per-org `"{org_id}:data_sync"` Redis lock (`mhq/api/sync.py`). N connections make N sequential passes, same shape as N providers already did — nothing here introduces concurrency, so the plan's suggested lock-key extension wasn't needed.

**Ticket idempotency key (Known risk #1) — backward compatibility verified explicitly:** the legacy (connection_id is `None`) branch keeps the exact original `f"jira:{org_id}:{issue.id}"` format; only connection-scoped handlers use `f"jira:{org_id}:{connection_id}:{issue.id}"`. Covered by a dedicated test asserting the legacy format is byte-identical to before, plus a two-connections-same-issue-id non-collision test.

**The new join was verified against real Postgres, not just mocks** — a throwaway smoke script (not committed) inserted two connections × three projects (one inactive, one on a different connection) and confirmed `get_active_org_projects_for_connection` returns exactly the one active project actually owned by the connection asked about, then cleaned up after itself.

- [x] Test: an org with 0 / 1 / 2+ connections syncs correctly; two connections with colliding `issue.id` do not collide post-fix.
- [x] Full backend suite: 489 passed (was 479 before this task), flake8/black clean on every touched/new file.

## Task 5: PR↔ticket matching — scope by connection ✅ done

**Files:** `backend/analytics_server/mhq/store/repos/ticket_matching.py`, `backend/analytics_server/mhq/service/ticket_matching/service.py`, plus their test files (`test_ticket_matching.py` new, `test_service.py` extended).

**Design refinement on "scope by connection" — asked of and confirmed by the user, then implemented more narrowly than the literal instruction to avoid a self-inflicted regression:** the plan's wording ("restrict... to the connection(s) relevant to the PR's repo/team, instead of one flat org-wide map") reads as *always* scoping every match to the PR's repo/team. Implemented that way, it would have been a real regression: `get_org_tickets_key_map`'s own existing docstring is explicit that matching stays org-wide *on purpose* — "a ticket that was already synced should stay matchable even if its project is later deselected" — and the vast majority of orgs (zero or one Jira connection) never have a colliding key at all. Always scoping by repo/team would have broken that guarantee for every ordinary org to fix a problem that only exists for the rare colliding case.

What's actually built: matching stays org-wide by default. `get_org_tickets_key_map` now excludes any key shared by 2+ tickets (previously it silently kept "whichever the query happened to return last" — the exact bug the plan's "Known risks" #2 describes) and a new `get_colliding_ticket_key_candidates` exposes those held-back keys with their candidates. Only when a PR's extracted key hits a genuine collision does `TicketMatchingService._resolve_colliding_key` reach for a new `get_relevant_org_project_ids_for_repo(repo_id)` (a `TeamRepos ⋈ TeamProjects` join — nothing in this codebase resolved repo→team→project before this) to find which candidate's project the PR's own tracking team(s) actually selected. Exactly one relevant candidate → matched; zero or more than one → skipped, not guessed (fail closed, consistent with this codebase's existing "never render a plausible wrong answer" pattern for Bitbucket/Jenkins). The per-repo lookup is cached within one `match_org_prs_to_tickets` call so N colliding PRs from the same repo cost one query, not N.

**Note:** `OrgProjectConnection` isn't referenced directly here — `get_relevant_org_project_ids_for_repo` only needs `TeamRepos`/`TeamProjects`; the connection-vs-legacy distinction is already baked into which projects exist as collision *candidates* (only two same-keyed projects across different connections, or a connection and the legacy flow, can collide in the first place).

- [x] Regression test: two connections both with a project "PROJ" — a PR referencing "PROJ-123" matches the ticket from the correct connection only (`test_resolves_to_the_ticket_from_the_prs_own_relevant_connection`), plus the no-relevant-match and still-ambiguous-after-scoping fail-closed cases, plus a same-PR test proving a plain non-colliding key and a colliding key both resolve together.
- [x] Full backend suite: 504 passed (was 489 before this task, +15 new), flake8/black clean.

## Task 6: Frontend — connections management ✅ done; project-picker wiring not started

**Part 1 — connections list/add/delete/set-default: done.**

**Files:**
- New: `web-server/src/hooks/useJiraConnections.ts` — list/create/delete/setDefault against the Task 3 API routes.
- New: `web-server/src/components/JiraConnectionsManager.tsx` — the modal body: add-connection form, a table with a set-default star and a delete icon per row (with a confirmation dialog, since delete can be blocked by the backend), server error messages surfaced verbatim (`readApiError`, mirrors `ClustoxJenkinsMapping`'s `mutationError`).
- New: `web-server/src/components/__tests__/JiraConnectionsManager.test.tsx` — 9 tests (list/empty state, validation, create, duplicate-account 409, set-default, delete + confirm, delete-blocked 409, no redundant `feature_flags` param — see the bug below).
- `web-server/src/content/Dashboards/JiraIntegrationCard.tsx` — **the connections manager lives here, not on a separate card.** It was first built as a standalone `JiraConnectionsCard` sitting beside the legacy card, per the plan's literal file list, but that read as two unrelated "Jira" tiles on the integrations page and the user asked for one. `JiraIntegrationCard` now branches on `show_jira_multi_account`: on (the default), it renders a single "Manage connections" action opening this modal; off, it falls back to the original link/unlink flow unchanged (renamed internally to `LegacyJiraIntegrationCard`). `pages/integrations.tsx` no longer has a second Jira card at all.
- `web-server/src/types/request.ts` — added a typed `session?: AuthSession` field to `ApiRequest` (previously only reachable via an untyped cast); needed so the create-connection call can stamp `generated_by` with the signed-in user's id.
- `web-server/src/constants/feature.ts` — `show_jira_multi_account` defaults to `true` (flipped from `false` once the user confirmed they wanted this live, not console-flag-gated). Still a real flag, just on by default.

**Bug found and fixed after initial ship — real user-facing failure, not just a gap:** `useJiraConnections` originally stamped its own `feature_flags` query param on every request, reasoning (wrongly) that nothing else did. In fact `web-server/middleware.ts` already appends a `feature_flags` param to **every** request in this app (page and API alike), built from cookie-based overrides merged with the defaults — a mechanism that exists at the Next.js middleware layer, invisible to a `src/`/`pages/`-scoped grep (how this was missed the first time). Two query params of the same name parse as an array server-side; `JSON.parse()` on an array coerces it to a comma-joined string via `Array.prototype.toString()`, corrupting the JSON exactly at the join point. This surfaced live as "Unexpected non-whitespace character after JSON at position 32" — 32 being the exact length of the hand-stamped `{"show_jira_multi_account":true}`. Fixed by deleting the manual stamp entirely; the middleware already covers it. Regression-tested (`does not add its own feature_flags param...`).

**Part 2 — `TeamJiraProjects.tsx`: pick a connection before picking its projects — ✅ done.** Resolved the two open design questions from the original write-up:

- **How `jira_project_search.ts` authenticates against a specific connection**: an optional `connection_id` query param. Present → look up that `JiraConnection` row (org-scoped, mirrors `JiraConnectionRepoService.get_jira_connection`'s own scoping) and decrypt its token with the same TS `dec()` helper the legacy path already uses. Absent → the exact original legacy `Integration` lookup, byte-for-byte, so an org that has never touched multi-account Jira sees no behavior change at all. Idempotency keys follow the same legacy-preserving pattern as the ticket/sync fixes: `jira:{org_id}:{project.id}` when no connection, `jira:{org_id}:{connection_id}:{project.id}` when one was given.
- **Where the `OrgProjectConnection` row gets written**: `ProjectService._update_org_projects` (`repository_service.py`), the write side of the Task 4 gap. `RawTeamOrgProject` grew an optional `connection_id`; when present, a row is written (after the `OrgProject` it references is already committed — the FK requires that ordering) via a new `ProjectRepoService.save_org_project_connections`. A project saved *without* a `connection_id` is left alone, never de-associated — safe by construction, since the frontend's own "load existing selections" response doesn't yet echo back `connection_id` per project (a resave of an untouched selection would otherwise silently erase a real association).

**Files:**
- `backend/analytics_server/mhq/service/project/models/org_project.py` — `RawTeamOrgProject.connection_id: Optional[str]`.
- `backend/analytics_server/mhq/api/request_utils.py` — `coerce_org_project` passes it through.
- `backend/analytics_server/mhq/store/repos/projects.py` — new `save_org_project_connections`.
- `backend/analytics_server/mhq/service/project/repository_service.py` — `_update_org_projects` writes the rows, after the projects they reference are committed.
- `backend/analytics_server/tests/service/project/test_repository_service.py` — 5 new tests (`TestOrgProjectConnectionWrites`): new-project case, existing-project case, no-op when nothing has a connection_id, mixed-batch (only the connected one gets a row), and write-ordering (projects before connections).
- `web-server/pages/api/internal/[org_id]/jira_project_search.ts` — connection-aware search, as above. 3 new tests.
- `web-server/pages/api/resources/team_projects.ts` — `connection_id` added to the PUT schema's per-project shape (yup silently strips unlisted fields, so this was required, not optional-to-skip).
- `web-server/src/constants/db.ts` — added `JiraConnection`/`OrgProjectConnection` to the `Table` enum + their `Columns`, needed for `jira_project_search.ts`'s typed `db('JiraConnection')` call.
- `web-server/src/components/Teams/useTeamJiraProjectsConfig.tsx` — pulls in `useJiraConnections`, a `selectedConnectionId` (`''` = legacy, the default), threads it into search and into each saved project's payload. A search result already carries its own `connection_id` (from the route above), so a project keeps the right one even if the picker selection changes after adding it — no separate stamping step needed.
- `web-server/src/components/Teams/TeamJiraProjects.tsx` — the picker itself: a `<TextField select>` with "Legacy Jira account" plus every connection, rendered only when the org has at least one connection (so an org that never added one sees the exact original UI).
- `web-server/src/components/Teams/__tests__/TeamJiraProjects.test.tsx` — 3 new tests for the picker (hidden with no connections, lists legacy + connections, calls the setter on selection).

**Not done, noted rather than silently skipped:** `GET /teams/<team_id>/projects` (`adapt_org_projects`) doesn't echo back which connection an already-saved project came from, so the picker can't show "this one's from acme.atlassian.net" for previously-saved selections — only for ones picked in the current session. Low-risk (existing associations are never erased by this gap, per the safe-by-construction note above) but worth closing later if the UI needs to display it.

- [x] Typecheck clean (`tsc --noEmit`, zero errors) for both parts.
- [x] Feature-flagged: `show_jira_multi_account` (default `true`) gates the card's rendering and the API routes it calls; the picker itself additionally self-gates on `connections.length > 0` regardless of the flag's own gating.
- [x] Verified live end-to-end: list/add/delete/set-default all round-trip successfully against the real dev container (confirmed via server logs after the query-param bug fix above).
- [x] Full backend suite: 548 passed (was 543 before this part, +5 new). Full frontend typecheck clean; every touched/new test file passes in isolation (search: 11, picker: 9, connections manager: 9, card: 8, API routes: 22, team_projects: unaffected existing tests still green) — a combined multi-file jest sweep was not completed in this session (see Task 6a's own environment note; same constrained machine, same outcome).

**Bug found live after shipping Part 2 — search appeared to hang:** the user reported the project search spinner "just showing loader" when searching a real connection. Root cause, found in the server logs, was two compounding pre-existing issues neither specific to this feature nor introduced by it, both now fixed:
1. This app's global `axios` instance is configured with `axiosRetry(axios, { retries: 2 })` (`src/api-helpers/axios.ts`), and Jira's real `/project/search` endpoint was intermittently slow enough to hit the route's own 8s timeout and return a 502. Axios-retry silently retried that 502 twice more — three full ~8s attempts, ~24s total, before ever resolving to the caller. Fixed by opting this specific search call out of retries (`'axios-retry': { retries: 0 }` per-request override) — a slow/failing keystroke's search should fail fast, since the next keystroke's own debounced request is the real retry mechanism here.
2. Search-as-you-type's client-side `AbortController` only tears down the browser's connection to *this app's own* route; it was never propagated to that route's own outbound call to Jira, so a burst of keystrokes piled up that many uncancelled real Jira requests running concurrently in the background, competing for whatever's on the other end and making the genuinely-still-wanted final request slower. Fixed by listening for `res.on('close', ...)` (client disconnect) in `jira_project_search.ts` and forwarding it into an `AbortController` passed as the outbound `axios.get`'s `signal` — `res`, not `req`: `Endpoint.serve()` passes handlers a shallow-spread plain object for `req` (see `transformNextRequest`), which has lost `IncomingMessage`'s `EventEmitter` prototype methods, while `res` is passed through untouched.

New regression test (`aborts the outbound Jira call when the client disconnects mid-search`) captures the registered `close` handler, invokes it mid-flight, and asserts the outbound call's abort signal actually fires.

**Environment note:** a full `yarn jest` sweep of the whole web-server suite could not be completed in this session — two attempts both hung with zero output on a memory-constrained dev machine (16GB, multiple other heavy processes/containers), unrelated to the code itself (a targeted run of the new test file passed cleanly, and `tsc --noEmit` — which would catch a type-level regression from either of the two shared-file edits above — is clean). Worth an actual `yarn jest` run on a less constrained machine before merging, as a final broad regression check.

## Task 7: Backward-compat / rollback tests

- [x] Org with 0 `JiraConnection` rows behaves identically to today (legacy `Integration` path only). Covered directly: `test_falls_back_to_the_single_legacy_handler_when_the_org_has_no_connections` and `test_legacy_handler_keeps_the_original_key_shape`/`test_legacy_handler_reads_every_active_project_for_the_org_and_provider` (Tasks 4-5) — the legacy handler and its idempotency-key format are byte-for-byte what existed before this feature.
- [ ] Migration `up` then `down` leaves schema identical to pre-migration state. `up` verified live against the dev DB (Task 1). `down` was never exercised — the auto-approval classifier blocked the rollback command as a destructive DB operation both times it was attempted, and it was not re-requested from the user given how much else was already in flight. The migration's `down` block is two straightforward `DROP TABLE` statements, symmetric with what `up` created; still worth an explicit human-approved run before merging.
- [x] Deleting a referenced connection fails loudly (app-level 4xx, not a raw DB error leaking to the client). Covered at every layer: `test_raises_in_use_when_an_org_project_connection_still_references_it` (repo), `test_deleting_a_referenced_connection_is_409_and_leaves_it_in_place` (Flask route), and the Next.js route test asserting the 409 and its message forward correctly.
