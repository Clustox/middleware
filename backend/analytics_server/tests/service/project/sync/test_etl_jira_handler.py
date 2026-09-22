from datetime import datetime
from unittest.mock import MagicMock, patch

from mhq.exapi.models.jira import JiraIssue
from mhq.service.project.sync.etl_jira_handler import (
    JiraETLHandler,
    get_jira_etl_handlers,
)
from mhq.store.models.projects import OrgProject, Ticket, TicketState

# CLUSTOX: Jira integration, Phase 2 (issue sync). See
# docs/JIRA_INTEGRATION_PROPOSAL.md. Uses the real JiraIssue/
# JiraChangelogEntry parser (already covered by tests/exapi/test_jira.py)
# so this file stays focused on JiraETLHandler's own job: building the
# JQL, and reconciling ids against existing rows without a per-item query.

ORG_ID = "org-1"


def _org_project(project_id="proj-1", key="PAY") -> OrgProject:
    return OrgProject(id=project_id, org_id=ORG_ID, key=key, name="Payments")


def _issue(issue_id="1", key="PAY-1", status_history=None) -> JiraIssue:
    return JiraIssue(
        {
            "id": issue_id,
            "key": key,
            "fields": {
                "summary": "Fix refund rounding",
                "status": {
                    "name": "In Progress",
                    "statusCategory": {"name": "In Progress"},
                },
                "issuetype": {"name": "Bug"},
                "created": "2024-01-01T10:00:00.000+0000",
                "updated": "2024-01-02T10:00:00.000+0000",
            },
            "changelog": {"histories": status_history or []},
        }
    )


def _status_change(history_id="100", from_status="To Do", to_status="In Progress"):
    return {
        "id": history_id,
        "created": "2024-01-01T11:00:00.000+0000",
        "items": [
            {
                "field": "status",
                "fromString": from_status,
                "toString": to_status,
            }
        ],
    }


def _handler(api=None, project_repo_service=None, connection_id=None) -> JiraETLHandler:
    return JiraETLHandler(
        ORG_ID,
        api or MagicMock(),
        project_repo_service or MagicMock(),
        connection_id=connection_id,
    )


class TestCheckPatValidity:
    def test_delegates_to_the_api_client(self):
        api = MagicMock()
        api.check_pat.return_value = True

        assert _handler(api).check_pat_validity() is True
        api.check_pat.assert_called_once()


class TestGetProjectIssuesData:
    def test_builds_jql_scoped_to_the_project_key_and_bookmark(self):
        api = MagicMock()
        api.get_all_issues.return_value = []
        org_project = _org_project(key="PAY")
        bookmark = datetime(2024, 1, 1, 9, 30)

        _handler(api).get_project_issues_data(org_project, bookmark)

        jql = api.get_all_issues.call_args[0][0]
        assert 'project = "PAY"' in jql
        assert '"2024-01-01 09:30"' in jql

    def test_returns_empty_lists_without_any_batch_lookup_when_nothing_changed(self):
        api = MagicMock()
        api.get_all_issues.return_value = []
        repo = MagicMock()

        tickets, states = _handler(api, repo).get_project_issues_data(
            _org_project(), datetime(2024, 1, 1)
        )

        assert tickets == []
        assert states == []
        repo.get_tickets_by_idempotency_keys.assert_not_called()

    def test_reuses_the_existing_tickets_id_when_the_idempotency_key_already_exists(
        self,
    ):
        api = MagicMock()
        api.get_all_issues.return_value = [_issue("1")]
        existing = Ticket(id="existing-ticket-id", idempotency_key=f"jira:{ORG_ID}:1")
        repo = MagicMock()
        repo.get_tickets_by_idempotency_keys.return_value = [existing]
        repo.get_ticket_states_by_idempotency_keys.return_value = []

        tickets, _ = _handler(api, repo).get_project_issues_data(
            _org_project(), datetime(2024, 1, 1)
        )

        assert len(tickets) == 1
        assert str(tickets[0].id) == "existing-ticket-id"
        assert tickets[0].idempotency_key == f"jira:{ORG_ID}:1"

    def test_mints_a_new_id_for_a_ticket_never_seen_before(self):
        api = MagicMock()
        api.get_all_issues.return_value = [_issue("1")]
        repo = MagicMock()
        repo.get_tickets_by_idempotency_keys.return_value = []
        repo.get_ticket_states_by_idempotency_keys.return_value = []

        tickets, _ = _handler(api, repo).get_project_issues_data(
            _org_project(), datetime(2024, 1, 1)
        )

        assert len(tickets) == 1
        assert tickets[0].id is not None

    def test_does_one_batch_lookup_for_all_tickets_in_the_page_not_one_per_ticket(
        self,
    ):
        api = MagicMock()
        api.get_all_issues.return_value = [_issue("1"), _issue("2"), _issue("3")]
        repo = MagicMock()
        repo.get_tickets_by_idempotency_keys.return_value = []
        repo.get_ticket_states_by_idempotency_keys.return_value = []

        _handler(api, repo).get_project_issues_data(
            _org_project(), datetime(2024, 1, 1)
        )

        repo.get_tickets_by_idempotency_keys.assert_called_once()
        looked_up_keys = repo.get_tickets_by_idempotency_keys.call_args[0][0]
        assert set(looked_up_keys) == {
            f"jira:{ORG_ID}:1",
            f"jira:{ORG_ID}:2",
            f"jira:{ORG_ID}:3",
        }

    def test_builds_a_ticket_state_per_status_transition_linked_to_its_ticket(self):
        api = MagicMock()
        api.get_all_issues.return_value = [
            _issue("1", status_history=[_status_change()])
        ]
        repo = MagicMock()
        repo.get_tickets_by_idempotency_keys.return_value = []
        repo.get_ticket_states_by_idempotency_keys.return_value = []

        tickets, states = _handler(api, repo).get_project_issues_data(
            _org_project(), datetime(2024, 1, 1)
        )

        assert len(states) == 1
        assert states[0].ticket_id == tickets[0].id
        assert states[0].from_status == "To Do"
        assert states[0].to_status == "In Progress"
        assert states[0].idempotency_key == f"jira:{ORG_ID}:1:100"

    def test_reuses_the_existing_ticket_states_id_when_its_idempotency_key_already_exists(
        self,
    ):
        api = MagicMock()
        api.get_all_issues.return_value = [
            _issue("1", status_history=[_status_change(history_id="100")])
        ]
        existing_state = TicketState(
            id="existing-state-id", idempotency_key=f"jira:{ORG_ID}:1:100"
        )
        repo = MagicMock()
        repo.get_tickets_by_idempotency_keys.return_value = []
        repo.get_ticket_states_by_idempotency_keys.return_value = [existing_state]

        _, states = _handler(api, repo).get_project_issues_data(
            _org_project(), datetime(2024, 1, 1)
        )

        assert len(states) == 1
        assert str(states[0].id) == "existing-state-id"

    def test_does_one_batch_lookup_for_all_ticket_states_regardless_of_issue_count(
        self,
    ):
        api = MagicMock()
        api.get_all_issues.return_value = [
            _issue("1", status_history=[_status_change("100"), _status_change("101")]),
            _issue("2", status_history=[_status_change("200")]),
        ]
        repo = MagicMock()
        repo.get_tickets_by_idempotency_keys.return_value = []
        repo.get_ticket_states_by_idempotency_keys.return_value = []

        _handler(api, repo).get_project_issues_data(
            _org_project(), datetime(2024, 1, 1)
        )

        repo.get_ticket_states_by_idempotency_keys.assert_called_once()
        looked_up_keys = repo.get_ticket_states_by_idempotency_keys.call_args[0][0]
        assert set(looked_up_keys) == {
            f"jira:{ORG_ID}:1:100",
            f"jira:{ORG_ID}:1:101",
            f"jira:{ORG_ID}:2:200",
        }


def _board(board_id=1076, board_type="scrum"):
    board = MagicMock()
    board.id = board_id
    board.board_type = board_type
    return board


def _sprint(sprint_id=299, name="Sprint 1", state="closed"):
    sprint = MagicMock()
    sprint.id = sprint_id
    sprint.name = name
    sprint.state = state
    sprint.start_date = datetime(2024, 1, 1)
    sprint.end_date = datetime(2024, 1, 15)
    return sprint


# CLUSTOX: Jira integration -- the Sprint rollup chart. See
# docs/JIRA_INTEGRATION_PROPOSAL.md §6D.
class TestGetProjectSprintsData:
    def test_returns_empty_list_when_the_project_has_no_scrum_board(self):
        api = MagicMock()
        api.get_boards_for_project.return_value = [_board(board_type="kanban")]

        sprints = _handler(api).get_project_sprints_data(_org_project())

        assert sprints == []
        api.get_sprints_for_board.assert_not_called()

    def test_returns_empty_list_when_the_project_has_no_boards_at_all(self):
        api = MagicMock()
        api.get_boards_for_project.return_value = []

        sprints = _handler(api).get_project_sprints_data(_org_project())

        assert sprints == []

    def test_fetches_counts_and_builds_sprints_for_a_scrum_board(self):
        api = MagicMock()
        api.get_boards_for_project.return_value = [_board()]
        api.get_sprints_for_board.return_value = [_sprint()]
        api.get_sprint_issue_counts.return_value = (355, 272)
        repo = MagicMock()
        repo.get_sprints_by_idempotency_keys.return_value = []

        [sprint] = _handler(api, repo).get_project_sprints_data(
            _org_project("proj-1", "PZDA")
        )

        assert sprint.name == "Sprint 1"
        assert sprint.state == "closed"
        assert sprint.planned_count == 355
        assert sprint.completed_count == 272
        assert sprint.org_project_id == "proj-1"
        assert sprint.idempotency_key == f"jira:{ORG_ID}:sprint:299"
        api.get_sprint_issue_counts.assert_called_once_with(299)

    def test_reuses_the_existing_row_id_for_an_already_synced_sprint(self):
        api = MagicMock()
        api.get_boards_for_project.return_value = [_board()]
        api.get_sprints_for_board.return_value = [_sprint()]
        api.get_sprint_issue_counts.return_value = (10, 5)
        existing = MagicMock()
        existing.idempotency_key = f"jira:{ORG_ID}:sprint:299"
        existing.id = "existing-row-id"
        repo = MagicMock()
        repo.get_sprints_by_idempotency_keys.return_value = [existing]

        [sprint] = _handler(api, repo).get_project_sprints_data(_org_project())

        assert sprint.id == "existing-row-id"

    def test_pulls_sprints_from_every_scrum_board_when_a_project_has_several(self):
        api = MagicMock()
        api.get_boards_for_project.return_value = [
            _board(board_id=1),
            _board(board_id=2),
        ]
        api.get_sprints_for_board.side_effect = [
            [_sprint(sprint_id=101)],
            [_sprint(sprint_id=201)],
        ]
        api.get_sprint_issue_counts.return_value = (1, 1)
        repo = MagicMock()
        repo.get_sprints_by_idempotency_keys.return_value = []

        sprints = _handler(api, repo).get_project_sprints_data(_org_project())

        assert {s.external_id for s in sprints} == {"101", "201"}


# CLUSTOX: Jira multi-account support. See docs/JIRA_MULTI_ACCOUNT_PLAN.md
# Task 4.
class TestConnectionScopedIdempotencyKey:
    def test_legacy_handler_keeps_the_original_key_shape(self):
        api = MagicMock()
        api.get_all_issues.return_value = [_issue("1")]
        repo = MagicMock()
        repo.get_tickets_by_idempotency_keys.return_value = []
        repo.get_ticket_states_by_idempotency_keys.return_value = []

        tickets, _ = _handler(api, repo).get_project_issues_data(
            _org_project(), datetime(2024, 1, 1)
        )

        # Not just "some format" -- byte-identical to what a pre-existing
        # ticket for this org already has as its idempotency_key, or this
        # sync would stop reusing the row and start duplicating it.
        assert tickets[0].idempotency_key == f"jira:{ORG_ID}:1"

    def test_connection_scoped_handler_includes_the_connection_id(self):
        api = MagicMock()
        api.get_all_issues.return_value = [_issue("1")]
        repo = MagicMock()
        repo.get_tickets_by_idempotency_keys.return_value = []
        repo.get_ticket_states_by_idempotency_keys.return_value = []

        tickets, _ = _handler(
            api, repo, connection_id="conn-1"
        ).get_project_issues_data(_org_project(), datetime(2024, 1, 1))

        assert tickets[0].idempotency_key == f"jira:{ORG_ID}:conn-1:1"

    def test_two_connections_do_not_collide_on_the_same_bare_issue_id(self):
        # The regression Task 4 exists to close: two connections' sites can
        # each have their own small, site-local issue id "1". Without
        # connection scoping both would idempotency-key to "jira:org-1:1"
        # and the second connection's ticket would silently overwrite the
        # first's.
        api = MagicMock()
        api.get_all_issues.return_value = [_issue("1")]
        repo = MagicMock()
        repo.get_tickets_by_idempotency_keys.return_value = []
        repo.get_ticket_states_by_idempotency_keys.return_value = []

        tickets_a, _ = _handler(
            api, repo, connection_id="conn-a"
        ).get_project_issues_data(_org_project(), datetime(2024, 1, 1))
        tickets_b, _ = _handler(
            api, repo, connection_id="conn-b"
        ).get_project_issues_data(_org_project(), datetime(2024, 1, 1))

        assert tickets_a[0].idempotency_key != tickets_b[0].idempotency_key


class TestGetOrgProjectsToSync:
    def test_legacy_handler_reads_every_active_project_for_the_org_and_provider(self):
        repo = MagicMock()
        repo.get_active_org_projects_for_provider.return_value = ["proj-a", "proj-b"]

        projects = _handler(project_repo_service=repo).get_org_projects_to_sync(ORG_ID)

        repo.get_active_org_projects_for_provider.assert_called_once_with(
            ORG_ID, "jira"
        )
        repo.get_active_org_projects_for_connection.assert_not_called()
        assert projects == ["proj-a", "proj-b"]

    def test_connection_scoped_handler_reads_only_its_own_connections_projects(self):
        repo = MagicMock()
        repo.get_active_org_projects_for_connection.return_value = ["proj-a"]

        projects = _handler(
            project_repo_service=repo, connection_id="conn-1"
        ).get_org_projects_to_sync(ORG_ID)

        repo.get_active_org_projects_for_connection.assert_called_once_with("conn-1")
        repo.get_active_org_projects_for_provider.assert_not_called()
        assert projects == ["proj-a"]


class TestGetJiraEtlHandlers:
    def test_falls_back_to_the_single_legacy_handler_when_the_org_has_no_connections(
        self,
    ):
        with patch(
            "mhq.service.project.sync.etl_jira_handler.JiraConnectionRepoService"
        ) as connection_repo_cls, patch(
            "mhq.service.project.sync.etl_jira_handler.get_jira_etl_handler"
        ) as get_legacy_handler:
            connection_repo_cls.return_value.list_jira_connections.return_value = []
            legacy_handler = MagicMock()
            get_legacy_handler.return_value = legacy_handler

            handlers = get_jira_etl_handlers(ORG_ID)

        assert handlers == [legacy_handler]

    def test_builds_one_handler_per_connection_with_its_own_credentials(self):
        connection_a = MagicMock(
            id="conn-a", email="a@acme.com", site_url="acme.atlassian.net"
        )
        connection_b = MagicMock(
            id="conn-b", email="b@other.com", site_url="other.atlassian.net"
        )

        with patch(
            "mhq.service.project.sync.etl_jira_handler.JiraConnectionRepoService"
        ) as connection_repo_cls, patch(
            "mhq.service.project.sync.etl_jira_handler.JiraApiService"
        ) as api_service_cls:
            connection_repo_service = connection_repo_cls.return_value
            connection_repo_service.list_jira_connections.return_value = [
                connection_a,
                connection_b,
            ]
            connection_repo_service.decrypt_access_token.side_effect = [
                "token-a",
                "token-b",
            ]

            handlers = get_jira_etl_handlers(ORG_ID)

        assert [h.connection_id for h in handlers] == ["conn-a", "conn-b"]
        assert api_service_cls.call_args_list == [
            (("a@acme.com", "token-a", "acme.atlassian.net"),),
            (("b@other.com", "token-b", "other.atlassian.net"),),
        ]

    def test_never_calls_the_legacy_handler_when_any_connection_exists(self):
        # The plan's strict either/or: a JiraConnection-backed org does not
        # also sync through the legacy Integration row, even if that row
        # still exists (see get_jira_etl_handlers's own docstring).
        with patch(
            "mhq.service.project.sync.etl_jira_handler.JiraConnectionRepoService"
        ) as connection_repo_cls, patch(
            "mhq.service.project.sync.etl_jira_handler.JiraApiService"
        ), patch(
            "mhq.service.project.sync.etl_jira_handler.get_jira_etl_handler"
        ) as get_legacy_handler:
            connection_repo_cls.return_value.list_jira_connections.return_value = [
                MagicMock(id="conn-a")
            ]

            get_jira_etl_handlers(ORG_ID)

        get_legacy_handler.assert_not_called()
