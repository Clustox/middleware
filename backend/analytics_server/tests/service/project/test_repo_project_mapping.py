from unittest.mock import MagicMock

import pytest

from mhq.service.project.repo_project_mapping import (
    RawRepoProjectMapping,
    RepoProjectMappingService,
)

# CLUSTOX: Repo <-> Project Mapping (docs/JIRA_INTEGRATION_PROPOSAL.md).
# Mirrors this repo's existing service-layer test style (fake/mock
# collaborators, no real DB) -- see test_repository_service.py's own note.


class FakeTeam:
    def __init__(self, id="team-1", org_id="org-1"):
        self.id = id
        self.org_id = org_id


class FakeRepo:
    def __init__(self, id, name):
        self.id = id
        self.name = name


class FakeProject:
    def __init__(self, id):
        self.id = id


def _service(
    repository_service=None, project_service=None, repo_project_mapping_repo=None
) -> RepoProjectMappingService:
    return RepoProjectMappingService(
        repository_service or MagicMock(),
        project_service or MagicMock(),
        repo_project_mapping_repo or MagicMock(),
    )


class TestGetTeamRepoProjectMapping:
    def test_returns_one_entry_per_team_repo_mapped_or_not(self):
        repository_service = MagicMock()
        repository_service.get_team_repos.return_value = [
            FakeRepo("repo-1", "payments-api"),
            FakeRepo("repo-2", "payments-web"),
        ]
        mapping_repo = MagicMock()
        mapping_repo.get_mapping_for_repos.return_value = {"repo-1": "project-a"}

        entries = _service(
            repository_service=repository_service,
            repo_project_mapping_repo=mapping_repo,
        ).get_team_repo_project_mapping(FakeTeam())

        assert len(entries) == 2
        by_id = {e.org_repo_id: e for e in entries}
        assert by_id["repo-1"].org_project_id == "project-a"
        assert by_id["repo-1"].repo_name == "payments-api"
        assert by_id["repo-2"].org_project_id is None
        assert by_id["repo-2"].repo_name == "payments-web"


class TestUpdateTeamRepoProjectMapping:
    def _service_for_team(self, repo_ids=("repo-1",), project_ids=("project-a",)):
        repository_service = MagicMock()
        repository_service.get_team_repos.return_value = [
            FakeRepo(rid, rid) for rid in repo_ids
        ]
        project_service = MagicMock()
        project_service.get_team_projects.return_value = [
            FakeProject(pid) for pid in project_ids
        ]
        mapping_repo = MagicMock()
        mapping_repo.get_mapping_for_repos.return_value = {}

        return (
            _service(
                repository_service=repository_service,
                project_service=project_service,
                repo_project_mapping_repo=mapping_repo,
            ),
            mapping_repo,
        )

    def test_sets_a_mapping_for_a_repo_and_project_that_both_belong_to_the_team(self):
        service, mapping_repo = self._service_for_team()

        service.update_team_repo_project_mapping(
            FakeTeam(),
            [RawRepoProjectMapping(org_repo_id="repo-1", org_project_id="project-a")],
        )

        mapping_repo.set_mapping.assert_called_once_with("repo-1", "project-a")
        mapping_repo.unset_mapping.assert_not_called()

    def test_none_project_id_unsets_the_mapping_instead_of_setting_it(self):
        service, mapping_repo = self._service_for_team()

        service.update_team_repo_project_mapping(
            FakeTeam(),
            [RawRepoProjectMapping(org_repo_id="repo-1", org_project_id=None)],
        )

        mapping_repo.unset_mapping.assert_called_once_with("repo-1")
        mapping_repo.set_mapping.assert_not_called()

    def test_rejects_a_repo_that_does_not_belong_to_this_team(self):
        service, mapping_repo = self._service_for_team(repo_ids=("repo-1",))

        with pytest.raises(Exception):
            service.update_team_repo_project_mapping(
                FakeTeam(),
                [
                    RawRepoProjectMapping(
                        org_repo_id="repo-from-another-team",
                        org_project_id="project-a",
                    )
                ],
            )

        mapping_repo.set_mapping.assert_not_called()

    def test_rejects_a_project_that_this_team_has_not_selected(self):
        service, mapping_repo = self._service_for_team(project_ids=("project-a",))

        with pytest.raises(Exception):
            service.update_team_repo_project_mapping(
                FakeTeam(),
                [
                    RawRepoProjectMapping(
                        org_repo_id="repo-1",
                        org_project_id="project-not-selected-by-team",
                    )
                ],
            )

        mapping_repo.set_mapping.assert_not_called()

    def test_a_bad_entry_blocks_the_whole_batch_including_valid_entries(self):
        # All-or-nothing validation, checked before any write -- a mix of
        # one valid and one invalid entry must not partially apply.
        service, mapping_repo = self._service_for_team(
            repo_ids=("repo-1", "repo-2"), project_ids=("project-a",)
        )

        with pytest.raises(Exception):
            service.update_team_repo_project_mapping(
                FakeTeam(),
                [
                    RawRepoProjectMapping(
                        org_repo_id="repo-1", org_project_id="project-a"
                    ),
                    RawRepoProjectMapping(
                        org_repo_id="repo-2", org_project_id="project-not-selected"
                    ),
                ],
            )

        mapping_repo.set_mapping.assert_not_called()
