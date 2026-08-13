from typing import Dict, List

from mhq.store import db, rollback_on_exc
from mhq.store.models.projects import RepoProjectMapping


class RepoProjectMappingRepoService:
    """
    CRUD for RepoProjectMapping -- see that model's own docstring for why
    a repo maps to at most one project and why unmapping is a real
    delete rather than a soft one.
    """

    def __init__(self):
        self._db = db

    @rollback_on_exc
    def get_mapping_for_repos(self, repo_ids: List[str]) -> Dict[str, str]:
        """org_repo_id -> org_project_id, for whichever of these repos
        have a mapping. Repos with none are simply absent from the
        result, not present with a null value."""
        if not repo_ids:
            return {}

        rows = (
            self._db.session.query(RepoProjectMapping)
            .filter(RepoProjectMapping.org_repo_id.in_(repo_ids))
            .all()
        )
        return {str(row.org_repo_id): str(row.org_project_id) for row in rows}

    @rollback_on_exc
    def set_mapping(self, org_repo_id: str, org_project_id: str) -> RepoProjectMapping:
        # merge, not add -- org_repo_id being the sole PK means a repo
        # that already has a mapping gets its row updated in place
        # (remapped to a different project), never a second row.
        mapping = self._db.session.merge(
            RepoProjectMapping(org_repo_id=org_repo_id, org_project_id=org_project_id)
        )
        self._db.session.commit()
        return mapping

    @rollback_on_exc
    def unset_mapping(self, org_repo_id: str) -> None:
        self._db.session.query(RepoProjectMapping).filter(
            RepoProjectMapping.org_repo_id == org_repo_id
        ).delete(synchronize_session=False)
        self._db.session.commit()


def get_repo_project_mapping_repo_service() -> RepoProjectMappingRepoService:
    return RepoProjectMappingRepoService()
