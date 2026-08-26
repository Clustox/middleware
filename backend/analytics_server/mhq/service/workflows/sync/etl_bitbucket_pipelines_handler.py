from datetime import datetime
from typing import Dict, List, Optional, Tuple
from uuid import uuid4

from mhq.exapi.bitbucket import BitbucketApiService
from mhq.service.workflows.sync.etl_provider_handler import WorkflowProviderETLHandler
from mhq.store.models.code import (
    OrgRepo,
    RepoWorkflow,
    RepoWorkflowRuns,
)
from mhq.store.models.code.workflows.enums import RepoWorkflowRunsStatus
from mhq.utils.log import LOG
from mhq.utils.time import dt_from_iso_time_string, time_now

# CLUSTOX: Pipelines results, folded onto our three terminal states.
# STOPPED maps to CANCELLED, not FAILURE -- a stopped run is an abort, the
# same call Jenkins makes for ABORTED. Counting an abort as a failed ship
# would inflate change failure rate.
_RESULT_STATUS_MAP = {
    "SUCCESSFUL": RepoWorkflowRunsStatus.SUCCESS,
    "FAILED": RepoWorkflowRunsStatus.FAILURE,
    "ERROR": RepoWorkflowRunsStatus.FAILURE,
    "STOPPED": RepoWorkflowRunsStatus.CANCELLED,
}


class BitbucketPipelinesETLHandler(WorkflowProviderETLHandler):
    def __init__(
        self,
        org_id: str,
        bitbucket_api_service: BitbucketApiService,
        workflow_repo_service,
    ):
        self.org_id = org_id
        self._api = bitbucket_api_service
        self._workflow_repo_service = workflow_repo_service

    def check_pat_validity(self) -> bool:
        is_valid = self._api.check_pat()
        if not is_valid:
            # The API cannot tell a revoked token from an expired one.
            raise Exception("Bitbucket API token is invalid, revoked or expired")
        return is_valid

    def get_workflow_runs(
        self,
        org_repo: OrgRepo,
        repo_workflow: RepoWorkflow,
        bookmark: datetime,
    ) -> Tuple[List[RepoWorkflowRuns], datetime]:
        # provider_workflow_id is "{workspace}/{slug}" -- written by the
        # picker's synthetic entry, split here. The repo's own org_name/slug
        # would usually agree, but the workflow row is the contract.
        workspace, _, repo_slug = repo_workflow.provider_workflow_id.partition("/")

        try:
            pipelines = self._api.get_repo_pipelines(workspace, repo_slug, bookmark)
        except Exception as e:
            # Raising leaves the bookmark unadvanced: this window re-fetches
            # next cycle. Same contract as the Jenkins handler.
            raise Exception(
                f"[Bitbucket Pipelines Sync] Error fetching pipelines for "
                f"{repo_workflow.provider_workflow_id}: {str(e)}"
            )

        if not pipelines:
            LOG.info(
                f"[Bitbucket Pipelines Sync] No runs found for "
                f"{repo_workflow.provider_workflow_id}. Org: {self.org_id}"
            )
            return [], bookmark

        runs: List[RepoWorkflowRuns] = []
        for pipeline in pipelines:
            try:
                runs.append(
                    self._adapt_pipeline_to_workflow_run(
                        str(repo_workflow.id), pipeline
                    )
                )
            except Exception as e:
                # One malformed run must not lose the rest of the batch.
                LOG.warning(
                    f"[Bitbucket Pipelines Sync] Skipping pipeline "
                    f"{pipeline.get('build_number')}: {str(e)}"
                )

        return runs, self._get_new_bookmark_time_stamp(pipelines)

    def _get_new_bookmark_time_stamp(self, pipelines: List[Dict]) -> datetime:
        """Rewind to the oldest still-running pipeline so it is re-fetched
        once it finishes. Mirrors the Jenkins and GitHub Actions handlers."""
        pending = [
            dt_from_iso_time_string(pipeline["created_on"])
            for pipeline in pipelines
            if pipeline.get("created_on") and not self._result_name(pipeline)
        ]
        return min(pending) if pending else time_now()

    def _adapt_pipeline_to_workflow_run(
        self, repo_workflow_id: str, pipeline: Dict
    ) -> RepoWorkflowRuns:
        build_number = pipeline["build_number"]
        existing = self._workflow_repo_service.get_repo_workflow_run_by_provider_workflow_run_id(
            repo_workflow_id, str(build_number)
        )
        run_id = existing.id if existing else uuid4()

        # completed_on is null while the run is in flight.
        conducted_at = pipeline.get("completed_on") or pipeline.get("created_on")

        return RepoWorkflowRuns(
            id=run_id,
            repo_workflow_id=repo_workflow_id,
            provider_workflow_run_id=str(build_number),
            event_actor=self._get_actor(pipeline),
            head_branch=self._get_branch(pipeline),
            status=self._get_status(pipeline),
            created_at=time_now(),
            updated_at=time_now(),
            conducted_at=dt_from_iso_time_string(conducted_at),
            # CLUSTOX: duration_in_seconds is ALREADY seconds. Jenkins divides
            # its milliseconds by 1000; copying that here would report a 450s
            # build as 0s.
            duration=pipeline.get("duration_in_seconds"),
            meta=pipeline,
            html_url=((pipeline.get("links") or {}).get("html") or {}).get("href"),
        )

    @staticmethod
    def _result_name(pipeline: Dict) -> Optional[str]:
        return (((pipeline.get("state") or {}).get("result")) or {}).get("name")

    def _get_status(self, pipeline: Dict) -> RepoWorkflowRunsStatus:
        result = self._result_name(pipeline)
        if not result:
            return RepoWorkflowRunsStatus.PENDING
        # An unrecognised result maps to FAILURE rather than being guessed as
        # a ship -- consistent with Jenkins treating UNSTABLE as FAILURE.
        return _RESULT_STATUS_MAP.get(result, RepoWorkflowRunsStatus.FAILURE)

    @staticmethod
    def _get_actor(pipeline: Dict) -> Optional[str]:
        creator = pipeline.get("creator") or {}
        trigger = pipeline.get("trigger") or {}
        return creator.get("nickname") or trigger.get("name")

    @staticmethod
    def _get_branch(pipeline: Dict) -> Optional[str]:
        """CLUSTOX: branches only. Prod-branch filtering happens downstream
        via RepoWorkflowFilter matching head_branch against branch regexes --
        a tag name masquerading as a branch could match one."""
        target = pipeline.get("target") or {}
        if target.get("ref_type") != "branch":
            return None
        return target.get("ref_name")


def get_bitbucket_pipelines_etl_handler(org_id: str) -> BitbucketPipelinesETLHandler:
    from mhq.store.models import UserIdentityProvider
    from mhq.store.repos.core import CoreRepoService
    from mhq.store.repos.workflows import WorkflowRepoService

    core_repo_service = CoreRepoService()
    access_token = core_repo_service.get_access_token(
        org_id, UserIdentityProvider.BITBUCKET
    )
    integrations = core_repo_service.get_org_integrations_for_names(
        org_id, [UserIdentityProvider.BITBUCKET.value]
    )
    email = (
        integrations[0].provider_meta.get("email")
        if integrations and integrations[0].provider_meta
        else None
    )
    if not (access_token and email):
        LOG.error(
            f"Bitbucket credentials incomplete for org {org_id}: "
            f"token {'present' if access_token else 'missing'}, "
            f"email {'present' if email else 'missing'}"
        )

    return BitbucketPipelinesETLHandler(
        org_id,
        BitbucketApiService(email or "", access_token or ""),
        WorkflowRepoService(),
    )
