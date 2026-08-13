from unittest.mock import MagicMock

from mhq.store.repos.repo_project_mapping import RepoProjectMappingRepoService


def _service_with_mock_db() -> (RepoProjectMappingRepoService, MagicMock):
    db = MagicMock()
    service = RepoProjectMappingRepoService()
    service._db = db
    return service, db


class _Row:
    def __init__(self, org_repo_id, org_project_id):
        self.org_repo_id = org_repo_id
        self.org_project_id = org_project_id


class TestGetMappingForRepos:
    def test_returns_empty_dict_for_an_empty_repo_id_list_without_querying(self):
        service, db = _service_with_mock_db()

        result = service.get_mapping_for_repos([])

        assert result == {}
        db.session.query.assert_not_called()

    def test_returns_repo_id_to_project_id_for_mapped_repos(self):
        service, db = _service_with_mock_db()
        db.session.query.return_value.filter.return_value.all.return_value = [
            _Row("repo-1", "project-a"),
            _Row("repo-2", "project-b"),
        ]

        result = service.get_mapping_for_repos(["repo-1", "repo-2"])

        assert result == {"repo-1": "project-a", "repo-2": "project-b"}

    def test_a_repo_with_no_mapping_is_simply_absent_not_none(self):
        service, db = _service_with_mock_db()
        db.session.query.return_value.filter.return_value.all.return_value = []

        result = service.get_mapping_for_repos(["repo-unmapped"])

        assert result == {}


class TestSetMapping:
    def test_merges_a_mapping_row_and_commits(self):
        service, db = _service_with_mock_db()

        service.set_mapping("repo-1", "project-a")

        merged = db.session.merge.call_args[0][0]
        assert str(merged.org_repo_id) == "repo-1"
        assert str(merged.org_project_id) == "project-a"
        db.session.commit.assert_called_once()

    def test_remapping_an_already_mapped_repo_merges_rather_than_adds(self):
        # org_repo_id is the sole PK -- merge() is what makes remapping an
        # update-in-place rather than a second row for the same repo.
        service, db = _service_with_mock_db()

        service.set_mapping("repo-1", "project-a")
        service.set_mapping("repo-1", "project-b")

        db.session.add.assert_not_called()
        assert db.session.merge.call_count == 2
        assert str(db.session.merge.call_args[0][0].org_project_id) == "project-b"


class TestUnsetMapping:
    def test_deletes_the_repos_mapping_row_and_commits(self):
        service, db = _service_with_mock_db()

        service.unset_mapping("repo-1")

        db.session.query.return_value.filter.return_value.delete.assert_called_once()
        db.session.commit.assert_called_once()
