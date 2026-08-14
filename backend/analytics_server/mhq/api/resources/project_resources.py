from typing import Dict, List

from mhq.service.project.repo_project_mapping import RepoProjectMappingEntry
from mhq.store.models.projects import OrgProject


def adapt_org_project(org_project: OrgProject) -> Dict[str, any]:
    return {
        "id": str(org_project.id),
        "org_id": str(org_project.org_id),
        "key": org_project.key,
        "name": org_project.name,
        "provider": org_project.provider,
        "is_active": org_project.is_active,
        "idempotency_key": org_project.idempotency_key,
        "created_at": org_project.created_at.isoformat(),
        "updated_at": org_project.updated_at.isoformat(),
    }


def adapt_org_projects(org_projects: List[OrgProject]) -> List[Dict[str, any]]:
    return [adapt_org_project(project) for project in org_projects]


def adapt_repo_project_mapping_entry(entry: RepoProjectMappingEntry) -> Dict[str, any]:
    return {
        "org_repo_id": entry.org_repo_id,
        "repo_name": entry.repo_name,
        "org_project_id": entry.org_project_id,
    }


def adapt_repo_project_mapping(
    entries: List[RepoProjectMappingEntry]
) -> List[Dict[str, any]]:
    return [adapt_repo_project_mapping_entry(entry) for entry in entries]
