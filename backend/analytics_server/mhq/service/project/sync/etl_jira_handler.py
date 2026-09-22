from datetime import datetime
from typing import Dict, List, Optional, Tuple

from mhq.exapi.jira import JiraApiService
from mhq.exapi.models.jira import JiraChangelogEntry, JiraIssue, JiraSprint
from mhq.service.project.sync.etl_provider_handler import ProjectProviderETLHandler
from mhq.store.models import UserIdentityProvider
from mhq.store.models.projects import OrgProject, Sprint, Ticket, TicketState
from mhq.store.repos.core import CoreRepoService
from mhq.store.repos.jira_connection import JiraConnectionRepoService
from mhq.store.repos.projects import ProjectRepoService
from mhq.utils.log import LOG
from mhq.utils.string import uuid4_str


class JiraETLHandler(ProjectProviderETLHandler):
    def __init__(
        self,
        org_id: str,
        jira_api_service: JiraApiService,
        project_repo_service: ProjectRepoService,
        connection_id: Optional[str] = None,
    ):
        self.org_id = org_id
        self._api = jira_api_service
        self._project_repo_service = project_repo_service
        # CLUSTOX: None means "the legacy, single-account Integration row" --
        # see docs/JIRA_MULTI_ACCOUNT_PLAN.md. Both the project scope
        # (get_org_projects_to_sync) and the ticket idempotency key branch on
        # this; a JiraConnection-backed handler always passes its own id.
        self.connection_id = connection_id

    def check_pat_validity(self) -> bool:
        return self._api.check_pat()

    def get_org_projects_to_sync(self, org_id: str) -> List[OrgProject]:
        if self.connection_id:
            return self._project_repo_service.get_active_org_projects_for_connection(
                self.connection_id
            )
        return self._project_repo_service.get_active_org_projects_for_provider(
            org_id, UserIdentityProvider.JIRA.value
        )

    def get_project_issues_data(
        self, org_project: OrgProject, bookmark: datetime
    ) -> Tuple[List[Ticket], List[TicketState]]:
        # JQL's own "updated >=" filter does the incremental narrowing
        # server-side (same idea as GitLab's updated_after param) rather
        # than fetching everything and truncating client-side the way the
        # GitHub PR sync has to.
        jql = (
            f'project = "{org_project.key}" '
            f'AND updated >= "{bookmark.strftime("%Y-%m-%d %H:%M")}" '
            f"ORDER BY updated ASC"
        )
        jira_issues = self._api.get_all_issues(jql)
        if not jira_issues:
            return [], []

        tickets = self._to_tickets(org_project, jira_issues)
        ticket_states = self._to_ticket_states(tickets, jira_issues)
        return tickets, ticket_states

    def _to_tickets(
        self, org_project: OrgProject, jira_issues: List[JiraIssue]
    ) -> List[Ticket]:
        idempotency_keys = [
            self._ticket_idempotency_key(issue) for issue in jira_issues
        ]
        # One batch lookup for every ticket in this page, not one query
        # per ticket -- avoids the per-item DB round trip the existing
        # GitHub PR sync pays (get_repo_pr_by_number, called once per PR).
        existing_id_by_key = {
            ticket.idempotency_key: ticket.id
            for ticket in self._project_repo_service.get_tickets_by_idempotency_keys(
                idempotency_keys
            )
        }

        return [
            Ticket(
                id=existing_id_by_key.get(idempotency_key, uuid4_str()),
                org_project_id=org_project.id,
                key=issue.key,
                provider=UserIdentityProvider.JIRA.value,
                status=issue.status,
                status_category=issue.status_category,
                idempotency_key=idempotency_key,
                data=issue.data,
                created_at=issue.created,
                updated_at=issue.updated,
            )
            for issue, idempotency_key in zip(jira_issues, idempotency_keys)
        ]

    def _to_ticket_states(
        self, tickets: List[Ticket], jira_issues: List[JiraIssue]
    ) -> List[TicketState]:
        entries_by_ticket: List[Tuple[Ticket, JiraChangelogEntry]] = [
            (ticket, entry)
            for ticket, issue in zip(tickets, jira_issues)
            for entry in issue.changelog
        ]
        if not entries_by_ticket:
            return []

        idempotency_keys = [
            self._ticket_state_idempotency_key(ticket, entry)
            for ticket, entry in entries_by_ticket
        ]
        existing_id_by_key = {
            state.idempotency_key: state.id
            for state in self._project_repo_service.get_ticket_states_by_idempotency_keys(
                idempotency_keys
            )
        }

        return [
            TicketState(
                id=existing_id_by_key.get(idempotency_key, uuid4_str()),
                ticket_id=ticket.id,
                from_status=entry.from_status,
                to_status=entry.to_status,
                changed_at=entry.changed_at,
                idempotency_key=idempotency_key,
                data=entry.data,
            )
            for (ticket, entry), idempotency_key in zip(
                entries_by_ticket, idempotency_keys
            )
        ]

    def get_project_sprints_data(self, org_project: OrgProject) -> List[Sprint]:
        boards = self._api.get_boards_for_project(org_project.key)
        scrum_boards = [board for board in boards if board.board_type == "scrum"]
        if not scrum_boards:
            return []

        jira_sprints = [
            sprint
            for board in scrum_boards
            for sprint in self._api.get_sprints_for_board(board.id)
        ]
        if not jira_sprints:
            return []

        return self._to_sprints(org_project, jira_sprints)

    def _to_sprints(
        self, org_project: OrgProject, jira_sprints: List[JiraSprint]
    ) -> List[Sprint]:
        idempotency_keys = [self._sprint_idempotency_key(s) for s in jira_sprints]
        existing_id_by_key = {
            sprint.idempotency_key: sprint.id
            for sprint in self._project_repo_service.get_sprints_by_idempotency_keys(
                idempotency_keys
            )
        }

        sprints = []
        for sprint, idempotency_key in zip(jira_sprints, idempotency_keys):
            planned_count, completed_count = self._api.get_sprint_issue_counts(
                sprint.id
            )
            sprints.append(
                Sprint(
                    id=existing_id_by_key.get(idempotency_key, uuid4_str()),
                    org_project_id=org_project.id,
                    provider=UserIdentityProvider.JIRA.value,
                    external_id=str(sprint.id),
                    name=sprint.name,
                    state=sprint.state,
                    start_date=sprint.start_date,
                    end_date=sprint.end_date,
                    planned_count=planned_count,
                    completed_count=completed_count,
                    idempotency_key=idempotency_key,
                )
            )
        return sprints

    def _sprint_idempotency_key(self, sprint: JiraSprint) -> str:
        # Scoped by org_id, same reasoning as _ticket_idempotency_key --
        # each org's Jira site is independent.
        return f"jira:{self.org_id}:sprint:{sprint.id}"

    def _ticket_idempotency_key(self, issue: JiraIssue) -> str:
        # Scoped by org_id, not the bare Jira issue id -- same reasoning as
        # OrgProject's idempotency_key: each org's Jira site is
        # independent, so two orgs' sites can land on the same id.
        #
        # CLUSTOX: also scoped by connection_id when this handler is
        # JiraConnection-backed -- two connections in the same org are two
        # independent Jira sites too, and a bare org_id scope would collide
        # their small, site-local issue ids (see docs/JIRA_MULTI_ACCOUNT_PLAN.md,
        # "Known risks" #1). The legacy (connection_id is None) branch keeps
        # the exact pre-existing key format: changing it would orphan every
        # ticket already synced through the single-account flow, which the
        # plan's backward-compat requirement (Task 7) rules out.
        if self.connection_id:
            return f"jira:{self.org_id}:{self.connection_id}:{issue.id}"
        return f"jira:{self.org_id}:{issue.id}"

    def _ticket_state_idempotency_key(
        self, ticket: Ticket, entry: JiraChangelogEntry
    ) -> str:
        return f"{ticket.idempotency_key}:{entry.idempotency_key}"


def get_jira_etl_handler(org_id: str) -> JiraETLHandler:
    """
    The legacy, single-account handler -- unchanged, so an org with zero
    JiraConnection rows syncs exactly as it did before this feature existed
    (docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 7). connection_id is left at its
    default (None): this handler's projects and idempotency keys use the
    original, org-scoped-only shape.
    """
    core_repo_service = CoreRepoService()
    site_url, email = _get_jira_site_and_email(core_repo_service, org_id)
    api_token = core_repo_service.get_access_token(org_id, UserIdentityProvider.JIRA)

    if not (site_url and email and api_token):
        LOG.error(f"Jira credentials incomplete for org {org_id}")

    return JiraETLHandler(
        org_id,
        JiraApiService(email, api_token, site_url),
        ProjectRepoService(),
    )


def get_jira_etl_handlers(org_id: str) -> List[JiraETLHandler]:
    """
    docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 4: an org with any JiraConnection
    rows syncs *only* those connections, one handler each, every handler
    scoped to its own connection's projects (get_org_projects_to_sync) and
    its own ticket idempotency-key namespace. An org with none falls back to
    the single legacy handler above -- this is a strict either/or, not
    "legacy plus whatever connections exist": the two flows are
    deliberately independent (see the plan's Global Constraints), so a
    project the legacy flow already syncs is not re-synced here just
    because the org later adds a JiraConnection: moving it over is Task 6's
    project picker, not something sync does on an org's behalf.
    """
    jira_connection_repo_service = JiraConnectionRepoService()
    connections = jira_connection_repo_service.list_jira_connections(org_id)
    if not connections:
        return [get_jira_etl_handler(org_id)]

    project_repo_service = ProjectRepoService()
    handlers = []
    for connection in connections:
        access_token = jira_connection_repo_service.decrypt_access_token(connection)
        handlers.append(
            JiraETLHandler(
                org_id,
                JiraApiService(connection.email, access_token, connection.site_url),
                project_repo_service,
                connection_id=str(connection.id),
            )
        )
    return handlers


def _get_jira_site_and_email(
    core_repo_service: CoreRepoService, org_id: str
) -> Tuple[str, str]:
    integrations = core_repo_service.get_org_integrations_for_names(
        org_id, [UserIdentityProvider.JIRA.value]
    )
    provider_meta: Dict = (integrations[0].provider_meta or {}) if integrations else {}
    return provider_meta.get("site_url"), provider_meta.get("email")
