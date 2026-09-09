from typing import List, Tuple
from uuid import UUID

from mhq.store import db, rollback_on_exc
from mhq.store.models.team_repo_project_mapping import TeamRepoProjectMapping


class TeamRepoProjectMappingRepoService:
    """
    Store layer for TeamRepoProjectMapping -- an explicit, informational
    pairing of a team's repo to a team's Jira project. See
    docs/JIRA_MULTI_ACCOUNT_PLAN.md's follow-up on Jira<->repo
    relationships, and the model's own docstring for why this never
    drives PR<->ticket matching.
    """

    def __init__(self):
        self._db = db

    @rollback_on_exc
    def get_mappings_for_team(self, team_id: str) -> List[TeamRepoProjectMapping]:
        return (
            self._db.session.query(TeamRepoProjectMapping)
            .filter(TeamRepoProjectMapping.team_id == team_id)
            .all()
        )

    @rollback_on_exc
    def set_mappings_for_team(
        self, team_id: str, pairs: List[Tuple[str, str]]
    ) -> List[TeamRepoProjectMapping]:
        """
        Replaces the team's full set of repo<->project pairings with
        exactly the given (org_repo_id, org_project_id) pairs. A plain
        join table with no other columns worth preserving across a save
        (unlike TeamRepos/TeamProjects, which carry their own is_active
        history), so a full delete-then-insert is simpler than diffing
        and just as correct -- there's nothing on an old row a caller
        could have wanted kept.
        """
        team_id = UUID(str(team_id))

        self._db.session.query(TeamRepoProjectMapping).filter(
            TeamRepoProjectMapping.team_id == team_id
        ).delete(synchronize_session=False)

        # CLUSTOX: normalize every PK column to the same Python type
        # (uuid.UUID) before the bulk insert below. org_repo_id/
        # org_project_id arrive as plain strings from the API layer
        # (uuid_validator only validates the format, it doesn't convert --
        # see request_utils.py); team_id can be either, depending on the
        # caller. Bulk-inserting a composite primary key with mixed str/
        # UUID values across rows breaks SQLAlchemy 2's insertmanyvalues
        # sentinel matching ("Can't match sentinel values in result set to
        # parameter sets") -- every column of the PK needs to be the same
        # Python type in every row, not just internally consistent per row.
        for repo_id, project_id in pairs:
            self._db.session.add(
                TeamRepoProjectMapping(
                    team_id=team_id,
                    org_repo_id=UUID(str(repo_id)),
                    org_project_id=UUID(str(project_id)),
                )
            )
        self._db.session.commit()
        return self.get_mappings_for_team(team_id)
