from dataclasses import dataclass
from typing import Optional


@dataclass
class RawTeamOrgProject:
    team_id: str
    provider: str
    key: str
    name: str
    idempotency_key: str
    # CLUSTOX: which JiraConnection this project was picked under, if any --
    # None means either a non-Jira provider or the legacy single-account
    # Integration flow. See docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 6 part 2.
    connection_id: Optional[str] = None
