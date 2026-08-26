# Bitbucket Pipelines Deployment Source Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bitbucket Pipelines runs as a deployment source — deployment frequency, CFR's denominator and merge-to-deploy for Bitbucket repos, exactly as Jenkins and GitHub Actions provide them today.

**Architecture:** One new client method (`get_repo_pipelines`), a `WorkflowProviderETLHandler` implementation mirroring `etl_jenkins_handler.py`, a factory branch, and a synthetic one-entry workflow list in the picker endpoint — a Bitbucket repo has exactly one pipeline system, so "selecting the deployment workflow" collapses to one choice that flows through the existing team-save persistence untouched.

**Tech Stack:** Flask 3 + SQLAlchemy 2, requests, Next.js 15 BFF.

**Spec:** `docs/BITBUCKET.md`, phase-2 section. **Branch:** `feat/bitbucket-pipelines` off `feat/bitbucket` (uses its client and integration row; one Bitbucket link serves both phases).

## Global Constraints

- **No database migration.** `RepoWorkflowProviders.BITBUCKET_PIPELINES` persists into a varchar column like `JENKINS` before it.
- Backend baseline **496 tests** (`cd backend/analytics_server && ./venv/bin/python -m pytest`; that venv is the only working one). Record old → new.
- Frontend `tsc` clean via the container; `black`/`flake8`/`eslint`/`prettier` clean on changed files.
- `# CLUSTOX:` / `// CLUSTOX:` comments explain WHY.
- One malformed pipeline run skips that run with a warning, never the batch — the Jenkins lesson, already in that handler's tests.
- 429 must never read as anything but a rate limit (phase-1 I3 lesson: `check_pat` raises `BitbucketRateLimitExceeded`).
- **Never run `docker compose`.** `docker cp` into the container is fine.
- Commit in logical chunks; do not amend or force-push.

---

### Task 1: Client — list a repo's pipeline runs

**Files:**
- Modify: `backend/analytics_server/mhq/exapi/bitbucket.py`
- Test: extend `backend/analytics_server/tests/exapi/test_bitbucket_api.py`

**Interfaces (Task 2 consumes verbatim):**

```python
def get_repo_pipelines(self, workspace: str, repo_slug: str,
                       updated_since: datetime) -> List[Dict]: ...
```

`GET /2.0/repositories/{ws}/{slug}/pipelines/` with `params={"sort": "-created_on", "pagelen": 50}`. The Pipelines API has no server-side date filter, so **stop paginating at the first page whose oldest run predates `updated_since`** and filter client-side — without the early stop, every sync walks the repo's entire pipeline history against a ~1,000 req/hr ceiling.

Realistic fixture (the shape the docs give; note `state` is nested two levels):

```python
BB_PIPELINE = {
    "uuid": "{d4e5f6a7-0000-4000-8000-000000000004}",
    "build_number": 412,
    "state": {
        "name": "COMPLETED",
        "result": {"name": "SUCCESSFUL"},
    },
    "target": {"ref_type": "branch", "ref_name": "main"},
    "creator": {"uuid": "{a1b2c3d4-0000-4000-8000-000000000001}", "nickname": "hamadr"},
    "trigger": {"name": "PUSH"},
    "created_on": "2026-08-20T10:00:00+00:00",
    "completed_on": "2026-08-20T10:07:30+00:00",
    "duration_in_seconds": 450,
    "links": {"html": {"href": "https://bitbucket.org/ws/repo/pipelines/results/412"}},
}
```

- [ ] Failing tests first: `test_pipelines_stop_paginating_before_the_bookmark` (two mocked pages, second never requested when the first's oldest run predates the bookmark), `test_pipelines_filtered_client_side` (runs older than `updated_since` absent from the result). Reuse `_service_with_pages`.
- [ ] Implement, full client suite green, `black`/`flake8`, commit (`feat(bitbucket-pipelines): list pipeline runs with bookmark-bounded pagination`)

---

### Task 2: The workflow ETL handler and registration

**Files:**
- Create: `backend/analytics_server/mhq/service/workflows/sync/etl_bitbucket_pipelines_handler.py`
- Modify: `backend/analytics_server/mhq/store/models/code/workflows/enums.py:4` — add `BITBUCKET_PIPELINES = "bitbucket"` (**the value mirrors `GITHUB_ACTIONS = "github"`**: the BFF's team-save writes `provider: curr.provider` — the repo's Integration value, `'bitbucket'` — into `RepoWorkflow.provider`. A distinct value like `"bitbucket_pipelines"` would orphan every row the UI writes. Verify the round trip in Task 4.)
- Modify: `backend/analytics_server/mhq/service/workflows/sync/etl_workflows_factory.py` (third branch; note the factory dispatches on **`.name`**, not `.value` — confirm what string the sync loop actually passes by reading its caller before wiring)
- Test: `backend/analytics_server/tests/service/workflows/sync/test_etl_bitbucket_pipelines_handler.py`

Mirror `JenkinsETLHandler` (`etl_jenkins_handler.py:31`) method-for-method against the two-method contract (`etl_provider_handler.py`): `check_pat_validity` (reuse `get_bitbucket_etl_handler`-style credentials: token via `CoreRepoService.get_access_token(org_id, UserIdentityProvider.BITBUCKET)`, email from `provider_meta`), and `get_workflow_runs(org_repo, repo_workflow, bookmark) -> Tuple[List[RepoWorkflowRuns], datetime]`.

The mapping rows (spec table, plus two decisions the spec must be corrected on):

| Ours | Pipelines | Note |
|---|---|---|
| `provider_workflow_run_id` | `build_number` as str | uuid also present; build_number matches Jenkins precedent and is human-legible in the drill-down |
| `status` | `state.result.name`: SUCCESSFUL→SUCCESS, FAILED/ERROR→FAILURE, **STOPPED→CANCELLED** | **Spec correction**: the spec said STOPPED→FAILURE, but Jenkins maps ABORTED→CANCELLED — a stopped run is an abort, not a failed ship, and counting it as FAILURE would inflate CFR. Update `docs/BITBUCKET.md` in this task. |
| in-progress (`state.name` != COMPLETED / no `result`) | PENDING | and the bookmark **rewinds to the oldest pending run** (`_get_new_bookmark_time_stamp`, Jenkins `:84`) so it re-fetches once finished |
| `conducted_at` | `completed_on`, fallback `created_on` | completed_on is null while running |
| `event_actor` | `creator.nickname`, fallback `trigger.name` | contributor filter works day one |
| `head_branch` | `target.ref_name` when `ref_type == "branch"`, else None | prod-branch filtering happens downstream via the existing `RepoWorkflowFilter` — do NOT filter here |
| `duration` | `duration_in_seconds` | already seconds — Jenkins divides ms, Pipelines must not |
| `html_url` | `links.html.href` | |
| `meta` | the raw run dict | |

- [ ] Failing tests mirroring `test_etl_jenkins_handler.py` (read it first; it covers status mapping, malformed-run skip, pending-bookmark rewind, actor/branch extraction). Minimum: all four status mappings + PENDING; malformed run skips that run only; bookmark rewinds to oldest pending; `duration` not divided; `head_branch` None for tag targets; idempotent re-sync (existing run id reused via `get_repo_workflow_run_by_provider_workflow_run_id`).
- [ ] Factory branch + extend the enum-to-factory completeness test pattern from phase 1 to `WorkflowETLFactory` (CIRCLE_CI is knowingly unregistered upstream — pin only that BITBUCKET_PIPELINES dispatches).
- [ ] Full suite, lint, commit (`feat(bitbucket-pipelines): workflow ETL handler and registration`)

---

### Task 3: The synthetic workflow entry in the picker

**Files:**
- Modify: `web-server/pages/api/internal/[org_id]/integrations/workflows.ts` (provider branches at `:25-54`)
- Test: extend `web-server/src/utils/__tests__/bitbucketRepos.test.ts` with the adapter if extracted, else a scoped test beside the endpoint's existing pattern — check what exists first

A Bitbucket repo has exactly one pipeline system, so the picker gets exactly one synthetic entry:

```ts
{ name: 'Bitbucket Pipelines', value: `${org_name}/${repo_slug}` }
```

- No Bitbucket API call is needed to "list" it — but the entry must only appear when the repo actually has pipelines enabled, or selecting it yields a workflow that never produces a run, silently. `GET /2.0/repositories/{ws}/{slug}/pipelines/?pagelen=1` (server-side, phase-1 credentials via `getBitbucketCredentials`) — non-empty → offer the entry; empty → return `[]` with the same shape the GitHub branch returns for a repo with no workflows.
- The value `{workspace}/{slug}` becomes `provider_workflow_id`, which is exactly what Task 2's handler splits to call `get_repo_pipelines`. Pin that contract in a test on whichever side is testable.

- [ ] `tsc`/eslint/prettier clean, scoped jest green, commit (`feat(bitbucket-pipelines): pipelines entry in the workflow picker`)

---

### Task 4: Round-trip verification and live gate

**Files:**
- Test: extend `backend/analytics_server/tests/service/workflows/sync/test_etl_bitbucket_pipelines_handler.py`

- [ ] **The provider round trip, pinned:** a `RepoWorkflow` row written the way the BFF writes it (`provider='bitbucket'`) must resolve through `RepoWorkflowProviders` to the factory branch and back. This is the exact class of gap that shipped twice before (enum registered, bucket/factory not — see phase 1's `CODE_INTEGRATION_BUCKET` test); assert it end to end at the unit level.
- [ ] **Sync-loop provider string:** read the workflow sync caller (`mhq/service/workflows/sync/etl_handler.py`) and assert with a test that whatever string it derives from a `provider='bitbucket'` row reaches `WorkflowETLFactory` without a `NotImplementedError`.
- [ ] **Live verification — the gate for the PR**, coordinated with the controller (requires a fresh Atlassian token from the user; the previous one is revoked):
  1. Re-link Bitbucket locally, map a repo that has real pipeline runs (probe first — `honest-water` may have none, in which case pick whichever `clustox` repo does, or accept "no runs found" as the verified-empty path and say so honestly).
  2. Trigger sync; verify `RepoWorkflowRuns` rows with real statuses, actors, branches.
  3. Verify `/deployment_frequency` counts them and the deployments drill-down deep-links to Bitbucket.
- [ ] Full suites, report all numbers, commit (`test(bitbucket-pipelines): provider round trip`)
