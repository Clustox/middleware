from unittest.mock import MagicMock

from mhq.store.repos.ticket_matching import TicketMatchingRepoService

# CLUSTOX: Jira multi-account support. See docs/JIRA_MULTI_ACCOUNT_PLAN.md
# Task 5.


def _service_with_mock_db() -> (TicketMatchingRepoService, MagicMock):
    db = MagicMock()
    service = TicketMatchingRepoService()
    service._db = db
    return service, db


def _stub_ticket_rows(db: MagicMock, rows):
    """rows: list of (ticket_id, key, org_project_id) tuples."""
    db.session.query.return_value.join.return_value.filter.return_value.all.return_value = (
        rows
    )


class TestGetOrgTicketsKeyMap:
    def test_maps_a_non_colliding_key_to_its_one_ticket(self):
        service, db = _service_with_mock_db()
        _stub_ticket_rows(db, [("ticket-1", "PZDA-543", "project-1")])

        result = service.get_org_tickets_key_map("org-1")

        assert result == {"PZDA-543": "ticket-1"}

    def test_uppercases_the_key(self):
        service, db = _service_with_mock_db()
        _stub_ticket_rows(db, [("ticket-1", "pzda-543", "project-1")])

        result = service.get_org_tickets_key_map("org-1")

        assert result == {"PZDA-543": "ticket-1"}

    def test_excludes_a_key_shared_by_two_tickets(self):
        # Two connections' sites both producing a "PROJ" project can land
        # two distinct tickets on the same key -- must not silently pick
        # one (see get_colliding_ticket_key_candidates for how these are
        # actually resolved).
        service, db = _service_with_mock_db()
        _stub_ticket_rows(
            db,
            [
                ("ticket-a", "PROJ-123", "project-a"),
                ("ticket-b", "PROJ-123", "project-b"),
            ],
        )

        result = service.get_org_tickets_key_map("org-1")

        assert result == {}

    def test_a_colliding_key_does_not_hide_an_unrelated_non_colliding_key(self):
        service, db = _service_with_mock_db()
        _stub_ticket_rows(
            db,
            [
                ("ticket-a", "PROJ-123", "project-a"),
                ("ticket-b", "PROJ-123", "project-b"),
                ("ticket-c", "PZDA-1", "project-c"),
            ],
        )

        result = service.get_org_tickets_key_map("org-1")

        assert result == {"PZDA-1": "ticket-c"}


class TestGetCollidingTicketKeyCandidates:
    def test_returns_every_candidate_for_a_shared_key(self):
        service, db = _service_with_mock_db()
        _stub_ticket_rows(
            db,
            [
                ("ticket-a", "PROJ-123", "project-a"),
                ("ticket-b", "PROJ-123", "project-b"),
            ],
        )

        result = service.get_colliding_ticket_key_candidates("org-1")

        assert result == {
            "PROJ-123": [("ticket-a", "project-a"), ("ticket-b", "project-b")]
        }

    def test_omits_keys_with_only_one_ticket(self):
        service, db = _service_with_mock_db()
        _stub_ticket_rows(db, [("ticket-1", "PZDA-543", "project-1")])

        result = service.get_colliding_ticket_key_candidates("org-1")

        assert result == {}


class TestGetRelevantOrgProjectIdsForRepo:
    def test_joins_team_projects_through_team_repos_before_filtering(self):
        service, db = _service_with_mock_db()
        query = db.session.query.return_value
        joined = query.join.return_value

        service.get_relevant_org_project_ids_for_repo("repo-1")

        assert query.join.call_count == 1
        joined.filter.assert_called_once()
        joined.filter.return_value.distinct.return_value.all.assert_called_once()

    def test_filters_by_repo_id_and_both_active_flags(self):
        service, db = _service_with_mock_db()
        joined = db.session.query.return_value.join.return_value

        service.get_relevant_org_project_ids_for_repo("repo-1")

        filter_args = joined.filter.call_args[0]
        # org_repo_id == repo-1, TeamRepos.is_active, TeamProjects.is_active
        # -- a deselected repo or project link must not disambiguate a
        # collision.
        assert len(filter_args) == 3

    def test_returns_a_deduplicated_set_of_project_ids(self):
        service, db = _service_with_mock_db()
        chain = db.session.query.return_value.join.return_value.filter.return_value
        chain.distinct.return_value.all.return_value = [
            ("project-a",),
            ("project-b",),
        ]

        result = service.get_relevant_org_project_ids_for_repo("repo-1")

        assert result == {"project-a", "project-b"}
