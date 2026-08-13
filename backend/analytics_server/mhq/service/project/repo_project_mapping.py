from dataclasses import dataclass
from typing import Dict, List, Optional

from mhq.service.code.repository_service import RepositoryService, get_repository_service
from mhq.service.project.repository_service import ProjectService, get_project_service
from mhq.store.models.core import Team
from mhq.store.repos.repo_project_mapping import (
    RepoProjectMappingRepoService,
    get_repo_project_mapping_repo_service,
)


@dataclass
class RepoProjectMappingEntry:
    org_repo_id: str
    repo_name: str
    org_project_id: Optional[str]


@dataclass
class RawRepoProjectMapping:
    org_repo_id: str
    # None means "unmap this repo" -- distinct from the key being absent,
    # which means "leave this repo's mapping untouched" (the PUT payload
    # only needs to carry entries the admin actually changed).
    org_project_id: Optional[str]


class RepoProjectMappingService:
    """
    Which single Jira project (if any) each of a team's repos maps to --
    see docs/JIRA_INTEGRATION_PROPOSAL.md and RepoProjectMapping's own
    docstring for why a repo maps to at most one project.

    Deliberately validates against the team's OWN repos/projects
    (RepositoryService.get_team_repos / ProjectService.get_team_projects)
    rather than trusting whatever org_repo_id/org_project_id a caller
    sends -- the same discipline update_team_projects already applies
    to idempotency-key collisions, applied here to catch a repo or
    project id that belongs to this org but a *different* team.
    """

    def __init__(
        self,
        repository_service: RepositoryService,
        project_service: ProjectService,
        repo_project_mapping_repo: RepoProjectMappingRepoService,
    ):
        self._repository_service = repository_service
        self._project_service = project_service
        self._repo = repo_project_mapping_repo

    def get_team_repo_project_mapping(self, team: Team) -> List[RepoProjectMappingEntry]:
        team_repos = self._repository_service.get_team_repos(team)
        repo_ids = [str(repo.id) for repo in team_repos]
        mapped_project_id_by_repo = self._repo.get_mapping_for_repos(repo_ids)

        return [
            RepoProjectMappingEntry(
                org_repo_id=str(repo.id),
                repo_name=repo.name,
                org_project_id=mapped_project_id_by_repo.get(str(repo.id)),
            )
            for repo in team_repos
        ]

    def update_team_repo_project_mapping(
        self, team: Team, raw_mappings: List[RawRepoProjectMapping]
    ) -> List[RepoProjectMappingEntry]:
        team_repo_ids = {
            str(repo.id) for repo in self._repository_service.get_team_repos(team)
        }
        team_project_ids = {
            str(project.id) for project in self._project_service.get_team_projects(team)
        }

        for raw in raw_mappings:
            if raw.org_repo_id not in team_repo_ids:
                raise Exception(
                    f"Repo {raw.org_repo_id} is not one of team {team.id}'s repos -- "
                    "refusing to write a mapping for a repo outside this team."
                )
            if raw.org_project_id is not None and raw.org_project_id not in team_project_ids:
                raise Exception(
                    f"Project {raw.org_project_id} is not one of team {team.id}'s "
                    "Jira projects -- refusing to map a repo to a project this "
                    "team hasn't selected."
                )

        for raw in raw_mappings:
            if raw.org_project_id is None:
                self._repo.unset_mapping(raw.org_repo_id)
            else:
                self._repo.set_mapping(raw.org_repo_id, raw.org_project_id)

        return self.get_team_repo_project_mapping(team)


def get_repo_project_mapping_service() -> RepoProjectMappingService:
    return RepoProjectMappingService(
        get_repository_service(),
        get_project_service(),
        get_repo_project_mapping_repo_service(),
    )
