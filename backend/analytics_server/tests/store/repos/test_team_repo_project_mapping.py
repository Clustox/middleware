from unittest.mock import MagicMock
from uuid import UUID

from mhq.store.repos.team_repo_project_mapping import TeamRepoProjectMappingRepoService

# CLUSTOX: explicit, informational repo<->Jira-project pairing. See
# docs/JIRA_MULTI_ACCOUNT_PLAN.md's follow-up on Jira<->repo relationships.

TEAM_ID = "11111111-1111-1111-1111-111111111111"
REPO_ID_1 = "22222222-2222-2222-2222-222222222222"
REPO_ID_2 = "33333333-3333-3333-3333-333333333333"
PROJECT_ID_1 = "44444444-4444-4444-4444-444444444444"


def _service_with_mock_db() -> (TeamRepoProjectMappingRepoService, MagicMock):
    db = MagicMock()
    service = TeamRepoProjectMappingRepoService()
    service._db = db
    return service, db


class TestGetMappingsForTeam:
    def test_filters_by_team_id(self):
        service, db = _service_with_mock_db()

        service.get_mappings_for_team(TEAM_ID)

        db.session.query.return_value.filter.assert_called_once()
        db.session.query.return_value.filter.return_value.all.assert_called_once()


class TestSetMappingsForTeam:
    def test_deletes_the_teams_existing_mappings_before_inserting_the_new_ones(self):
        service, db = _service_with_mock_db()
        calls = []
        db.session.query.return_value.filter.return_value.delete.side_effect = (
            lambda **kwargs: calls.append("delete")
        )
        db.session.commit.side_effect = lambda: calls.append("commit")

        service.set_mappings_for_team(TEAM_ID, [(REPO_ID_1, PROJECT_ID_1)])

        assert calls == ["delete", "commit"]

    def test_scopes_the_delete_to_this_team_only(self):
        service, db = _service_with_mock_db()

        service.set_mappings_for_team(TEAM_ID, [])

        filter_args = db.session.query.return_value.filter.call_args[0]
        assert len(filter_args) == 1

    def test_adds_one_row_per_pair(self):
        service, db = _service_with_mock_db()

        service.set_mappings_for_team(
            TEAM_ID, [(REPO_ID_1, PROJECT_ID_1), (REPO_ID_2, PROJECT_ID_1)]
        )

        added = [call.args[0] for call in db.session.add.call_args_list]
        assert len(added) == 2
        assert {(str(a.org_repo_id), str(a.org_project_id)) for a in added} == {
            (REPO_ID_1, PROJECT_ID_1),
            (REPO_ID_2, PROJECT_ID_1),
        }
        assert all(str(a.team_id) == TEAM_ID for a in added)

    def test_an_empty_set_of_pairs_still_clears_the_teams_existing_mappings(self):
        # Saving "no pairings" (an admin unlinking everything) must not be
        # a no-op -- it has to actually clear what was there before.
        service, db = _service_with_mock_db()

        service.set_mappings_for_team(TEAM_ID, [])

        db.session.query.return_value.filter.return_value.delete.assert_called_once()
        db.session.add.assert_not_called()
        db.session.commit.assert_called_once()

    # CLUSTOX: regression test for a real bug -- team_id arrives as a real
    # uuid.UUID (the caller in teams.py passes team.id, straight off the
    # loaded Team ORM instance), while org_repo_id/org_project_id arrive as
    # plain strings (uuid_validator in request_utils.py only validates the
    # format, it never converts). Constructing every row's primary key from
    # that mix -- UUID object for team_id, str for the other two columns --
    # bulk-inserted SQLAlchemy 2's insertmanyvalues into raising
    # "Can't match sentinel values in result set to parameter sets", a 500
    # on every save. Every PK column must come out as the same Python type
    # (uuid.UUID) regardless of what type each argument arrived as.
    def test_normalizes_every_pk_column_to_uuid_regardless_of_input_type(self):
        service, db = _service_with_mock_db()

        service.set_mappings_for_team(
            UUID(TEAM_ID),  # as the real caller passes it: team.id, already a UUID
            [(REPO_ID_1, PROJECT_ID_1)],  # as the real caller passes it: plain strings
        )

        added = db.session.add.call_args_list[0].args[0]
        assert type(added.team_id) is UUID
        assert type(added.org_repo_id) is UUID
        assert type(added.org_project_id) is UUID
