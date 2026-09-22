from typing import List

from mhq.store.models import Integration, UserIdentityProvider
from mhq.store.repos.core import CoreRepoService
from mhq.store.repos.jira_connection import JiraConnectionRepoService

# CLUSTOX: Jira integration, Phase 2 (issue sync). Mirrors
# mhq/service/code/integration.py's CODE_INTEGRATION_BUCKET -- one entry
# today, but kept as a bucket (not a single value) for the same reason
# that one is: room for another project-tracking tool later without
# reshaping this service.
PROJECT_INTEGRATION_BUCKET = [
    UserIdentityProvider.JIRA.value,
]


class ProjectIntegrationService:
    def __init__(
        self,
        core_repo_service: CoreRepoService,
        jira_connection_repo_service: JiraConnectionRepoService,
    ):
        self.core_repo_service = core_repo_service
        self.jira_connection_repo_service = jira_connection_repo_service

    def get_org_providers(self, org_id: str) -> List[str]:
        integrations: List[Integration] = (
            self.core_repo_service.get_org_integrations_for_names(
                org_id, PROJECT_INTEGRATION_BUCKET
            )
        )
        providers = {integration.name for integration in integrations}

        # CLUSTOX: an org can go straight to JiraConnection without ever
        # linking the legacy Integration(name='jira') row -- see
        # docs/JIRA_MULTI_ACCOUNT_PLAN.md. Checking only Integration here
        # left such an org with an empty provider list, and
        # sync_project_issues returns before ever calling the Jira ETL
        # factory -- a JiraConnection-only org would silently never sync.
        if self.jira_connection_repo_service.list_jira_connections(org_id):
            providers.add(UserIdentityProvider.JIRA.value)

        return list(providers)


def get_project_integration_service():
    return ProjectIntegrationService(
        core_repo_service=CoreRepoService(),
        jira_connection_repo_service=JiraConnectionRepoService(),
    )
