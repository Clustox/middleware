from typing import List

from mhq.service.project.sync.etl_jira_handler import get_jira_etl_handlers
from mhq.service.project.sync.etl_provider_handler import ProjectProviderETLHandler
from mhq.store.models import UserIdentityProvider


class ProjectETLFactory:
    def __init__(self, org_id: str):
        self.org_id = org_id

    # CLUSTOX: returns a list, not a single handler -- Jira can now resolve
    # to several (one per JiraConnection). See
    # docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 4.
    def __call__(self, provider: str) -> List[ProjectProviderETLHandler]:
        if provider == UserIdentityProvider.JIRA.value:
            return get_jira_etl_handlers(self.org_id)

        raise NotImplementedError(f"Unknown provider - {provider}")
