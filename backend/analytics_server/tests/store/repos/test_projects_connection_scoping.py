from unittest.mock import MagicMock

from mhq.store.repos.projects import ProjectRepoService

# CLUSTOX: Jira multi-account support. See docs/JIRA_MULTI_ACCOUNT_PLAN.md
# Task 4. get_active_org_projects_for_connection is the read side of the
# OrgProjectConnection join a connection-scoped JiraETLHandler depends on to
# know which projects are its own -- getting the join wrong here means a
# connection either syncs nothing or syncs another connection's projects.


def _service_with_mock_db() -> (ProjectRepoService, MagicMock):
    db = MagicMock()
    service = ProjectRepoService()
    service._db = db
    return service, db


class TestGetActiveOrgProjectsForConnection:
    def test_joins_through_org_project_connection_before_filtering(self):
        service, db = _service_with_mock_db()
        query = db.session.query.return_value
        joined = query.join.return_value

        service.get_active_org_projects_for_connection("conn-1")

        # The join is what makes filtering by jira_connection_id possible at
        # all -- OrgProject itself carries no connection column.
        assert query.join.call_count == 1
        joined.filter.assert_called_once()
        joined.filter.return_value.all.assert_called_once()

    def test_filters_by_the_given_connection_and_active_projects_only(self):
        service, db = _service_with_mock_db()
        joined = db.session.query.return_value.join.return_value

        service.get_active_org_projects_for_connection("conn-1")

        filter_args = joined.filter.call_args[0]
        # jira_connection_id == "conn-1" AND is_active -- both conditions,
        # or an inactive/deselected project would keep syncing forever, or
        # a bare join with no connection filter would return every
        # connection's projects.
        assert len(filter_args) == 2
