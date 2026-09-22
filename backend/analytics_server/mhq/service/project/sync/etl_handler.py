from datetime import datetime
from typing import List

import pytz

from mhq.service.bookmark import BookmarkService, BookmarkType, get_bookmark_service
from mhq.service.project.integration import get_project_integration_service
from mhq.service.project.sync.etl_project_factory import ProjectETLFactory
from mhq.service.project.sync.etl_provider_handler import ProjectProviderETLHandler
from mhq.store.models.projects import OrgProject
from mhq.store.repos.projects import ProjectRepoService
from mhq.utils.log import LOG


class ProjectETLHandler:
    """Provider-agnostic orchestrator -- mirrors CodeETLHandler."""

    def __init__(
        self,
        project_repo_service: ProjectRepoService,
        etl_service: ProjectProviderETLHandler,
        bookmark_service: BookmarkService,
    ):
        self.project_repo_service = project_repo_service
        self.etl_service = etl_service
        self.bookmark_service = bookmark_service

    def sync_org_projects(self, org_id: str, provider: str) -> None:
        if not self.etl_service.check_pat_validity():
            LOG.error("Invalid PAT for project provider")
            return

        # CLUSTOX: which projects to sync is now the handler's own call, not
        # a blanket "every active project for org+provider" query here -- a
        # connection-scoped JiraETLHandler must only touch its connection's
        # own projects. See docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 4.
        org_projects: List[OrgProject] = self.etl_service.get_org_projects_to_sync(
            org_id
        )
        for org_project in org_projects:
            try:
                self._sync_project_issues(org_project, provider)
            except Exception as e:
                LOG.error(
                    f"Error syncing issues for project {org_project.key}: {str(e)}"
                )
                continue

            try:
                self._sync_project_sprints(org_project)
            except Exception as e:
                LOG.error(
                    f"Error syncing sprints for project {org_project.key}: {str(e)}"
                )
                continue

    def _sync_project_issues(self, org_project: OrgProject, provider: str) -> None:
        bookmark: datetime = self.bookmark_service.get_bookmark(
            str(org_project.id),
            BookmarkType.PROJECT_ISSUES_BOOKMARK,
            provider,
        )
        tickets, ticket_states = self.etl_service.get_project_issues_data(
            org_project, bookmark
        )
        self.project_repo_service.save_tickets_data(tickets, ticket_states)

        if not tickets:
            # Nothing changed since the bookmark -- re-save it as-is so
            # the row exists (first sync for this project) rather than
            # leaving it perpetually unset.
            self.bookmark_service.update_bookmark(
                str(org_project.id),
                BookmarkType.PROJECT_ISSUES_BOOKMARK,
                provider,
                bookmark,
            )
            return

        tickets.sort(key=lambda ticket: ticket.updated_at)
        new_bookmark = tickets[-1].updated_at.astimezone(tz=pytz.UTC)
        self.bookmark_service.update_bookmark(
            str(org_project.id),
            BookmarkType.PROJECT_ISSUES_BOOKMARK,
            provider,
            new_bookmark,
        )

    def _sync_project_sprints(self, org_project: OrgProject) -> None:
        # No bookmark -- see Sprint's own docstring for why re-fetching
        # everything each cycle is the right call here, unlike issues.
        sprints = self.etl_service.get_project_sprints_data(org_project)
        if not sprints:
            return
        self.project_repo_service.save_sprints(sprints)


def sync_project_issues(org_id: str) -> None:
    providers: List[str] = get_project_integration_service().get_org_providers(org_id)
    if not providers:
        LOG.info(f"No project-tracking integrations found for org {org_id}")
        return

    etl_factory = ProjectETLFactory(org_id)

    for provider in providers:
        try:
            # CLUSTOX: one provider can now resolve to several handlers --
            # one per JiraConnection, see docs/JIRA_MULTI_ACCOUNT_PLAN.md
            # Task 4. Sequential on purpose: N connections make N sync
            # passes, same as N providers already did, and the whole call
            # already runs inside the per-org "{org_id}:data_sync" Redis
            # lock (mhq/api/sync.py) -- nothing here runs concurrently, so
            # no new lock or connection-scoped isolation primitive is
            # needed for this.
            etl_services = etl_factory(provider)
        except Exception as e:
            LOG.error(f"Error building ETL handlers for provider {provider}: {str(e)}")
            continue

        for etl_service in etl_services:
            try:
                project_etl_handler = ProjectETLHandler(
                    ProjectRepoService(),
                    etl_service,
                    get_bookmark_service(),
                )
                project_etl_handler.sync_org_projects(org_id, provider)
            except Exception as e:
                # One connection's failure must not stop its siblings' --
                # the same reasoning as the per-project try/except above,
                # one level up.
                LOG.error(
                    f"Error syncing org project issues for provider {provider}: {str(e)}"
                )
                continue
        LOG.info(f"Synced org project issues for provider {provider}")
    LOG.info(f"Synced all org project issues for org {org_id}")
