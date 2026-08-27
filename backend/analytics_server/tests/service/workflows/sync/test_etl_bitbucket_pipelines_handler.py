from datetime import datetime, timezone
from uuid import uuid4

from mhq.service.workflows.sync.etl_bitbucket_pipelines_handler import (
    BitbucketPipelinesETLHandler,
)
from mhq.store.models.code import RepoWorkflowProviders
from mhq.store.models.code.workflows.enums import RepoWorkflowRunsStatus
from tests.exapi.test_bitbucket_api import BB_PIPELINE


class FakeWorkflowRepoService:
    def get_repo_workflow_run_by_provider_workflow_run_id(
        self, repo_workflow_id, provider_workflow_run_id
    ):
        return None


class FakeBitbucketApiService:
    def __init__(self, pipelines=None):
        self._pipelines = pipelines or []

    def get_repo_pipelines(self, workspace, repo_slug, updated_since):
        return self._pipelines


class _Workflow:
    def __init__(self):
        self.id = uuid4()
        self.provider_workflow_id = "clustox/honest-water"


class _Repo:
    def __init__(self):
        self.id = uuid4()
        self.repo_id = self.id
        self.org_name = "clustox"
        self.slug = "honest-water"


def _handler(pipelines):
    return BitbucketPipelinesETLHandler(
        org_id="org-1",
        bitbucket_api_service=FakeBitbucketApiService(pipelines),
        workflow_repo_service=FakeWorkflowRepoService(),
    )


def _runs(pipelines):
    handler = _handler(pipelines)
    return handler.get_workflow_runs(
        _Repo(), _Workflow(), datetime(2026, 1, 1, tzinfo=timezone.utc)
    )


def _pipeline(**overrides):
    base = dict(BB_PIPELINE)
    base.update(overrides)
    return base


def test_successful_maps_to_success():
    runs, _ = _runs([_pipeline()])
    assert runs[0].status == RepoWorkflowRunsStatus.SUCCESS


def test_failed_and_error_map_to_failure():
    for result in ["FAILED", "ERROR"]:
        runs, _ = _runs(
            [_pipeline(state={"name": "COMPLETED", "result": {"name": result}})]
        )
        assert runs[0].status == RepoWorkflowRunsStatus.FAILURE


def test_stopped_maps_to_cancelled_not_failure():
    # CLUSTOX: a stopped run is an abort, not a failed ship -- Jenkins maps
    # ABORTED the same way. Counting it as FAILURE would inflate CFR.
    runs, _ = _runs(
        [_pipeline(state={"name": "COMPLETED", "result": {"name": "STOPPED"}})]
    )
    assert runs[0].status == RepoWorkflowRunsStatus.CANCELLED


def test_in_progress_maps_to_pending_and_rewinds_the_bookmark():
    running = _pipeline(
        build_number=413,
        state={"name": "IN_PROGRESS"},
        created_on="2026-08-21T09:00:00+00:00",
        completed_on=None,
    )
    finished = _pipeline(created_on="2026-08-22T09:00:00+00:00")

    runs, bookmark = _runs([finished, running])

    by_number = {r.provider_workflow_run_id: r for r in runs}
    assert by_number["413"].status == RepoWorkflowRunsStatus.PENDING
    # CLUSTOX: the bookmark rests at the oldest still-running pipeline so it
    # is re-fetched once it finishes -- the Jenkins/GitHub Actions contract.
    assert bookmark == datetime(2026, 8, 21, 9, 0, tzinfo=timezone.utc)


def test_adapt_maps_every_field():
    runs, _ = _runs([_pipeline()])
    run = runs[0]

    assert run.provider_workflow_run_id == "412"
    assert run.event_actor == "hamadr"
    assert run.head_branch == "main"
    assert run.conducted_at == datetime(2026, 8, 20, 10, 7, 30, tzinfo=timezone.utc)
    # CLUSTOX: duration_in_seconds is ALREADY seconds. Jenkins divides its
    # milliseconds by 1000; copying that here would report 450s builds as 0s.
    assert run.duration == 450
    assert run.html_url == "https://bitbucket.org/ws/repo/pipelines/results/412"


def test_actor_falls_back_to_trigger_name():
    runs, _ = _runs([_pipeline(creator=None)])
    assert runs[0].event_actor == "PUSH"


def test_tag_target_has_no_head_branch():
    # CLUSTOX: prod-branch filtering happens downstream via RepoWorkflowFilter
    # matching head_branch -- a tag name masquerading as a branch would let a
    # tag build match a branch regex.
    runs, _ = _runs([_pipeline(target={"ref_type": "tag", "ref_name": "v1.2.3"})])
    assert runs[0].head_branch is None


def test_conducted_at_falls_back_to_created_on_while_running():
    runs, _ = _runs([_pipeline(state={"name": "IN_PROGRESS"}, completed_on=None)])
    assert runs[0].conducted_at == datetime(2026, 8, 20, 10, 0, tzinfo=timezone.utc)


def test_a_malformed_run_is_skipped_without_losing_the_batch():
    runs, _ = _runs([_pipeline(), {"garbage": True}])
    assert len(runs) == 1


def test_bitbucket_pipelines_dispatches_through_the_factory():
    # CLUSTOX: the round trip that has silently broken twice before -- the
    # sync loop derives RepoWorkflowProviders('bitbucket') from the Integration
    # row's name and dispatches the factory on .name. Any link in that chain
    # missing means mapped pipelines never sync, with no error anywhere.
    from mhq.service.workflows.integration import WORKFLOW_INTEGRATION_BUCKET
    from mhq.service.workflows.sync.etl_workflows_factory import WorkflowETLFactory
    import inspect

    provider = RepoWorkflowProviders("bitbucket")
    assert provider == RepoWorkflowProviders.BITBUCKET_PIPELINES
    assert provider.value in WORKFLOW_INTEGRATION_BUCKET
    assert f"RepoWorkflowProviders.{provider.name}.name" in inspect.getsource(
        WorkflowETLFactory
    )
