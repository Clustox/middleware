from sqlalchemy import func
from sqlalchemy.dialects.postgresql import UUID

from mhq.store import db


class TeamRepoProjectMapping(db.Model):
    """
    Explicit, informational pairing of one of a team's repos to one of its
    Jira projects -- see docs/JIRA_MULTI_ACCOUNT_PLAN.md's follow-up on
    Jira<->repo relationships. A dedicated package rather than living
    under either `code` or `projects`, mirroring PullRequestTicketMapping:
    it's a join across those two domains, and cramming it into either
    one's package would make that package responsible for a model it
    only half owns.

    Deliberately informational only: nothing in TicketMatchingService or
    any sync handler reads this table. PR<->ticket association keeps
    resolving purely from the Jira issue key found in the PR title. This
    exists so an admin can record and see which repo goes with which
    project once a team has more than one of each -- organization/
    reporting, not a matching constraint.

    Many-to-many, not a single project_id on OrgRepo (or vice versa) -- a
    repo can reasonably pair with more than one project and a project
    with more than one repo (see Test Scenario 1 in the product spec this
    was requested against: one Jira project, four repos).
    """

    __tablename__ = "TeamRepoProjectMapping"

    team_id = db.Column(UUID(as_uuid=True), db.ForeignKey("Team.id"), primary_key=True)
    org_repo_id = db.Column(
        UUID(as_uuid=True), db.ForeignKey("OrgRepo.id"), primary_key=True
    )
    org_project_id = db.Column(
        UUID(as_uuid=True), db.ForeignKey("OrgProject.id"), primary_key=True
    )
    created_at = db.Column(db.DateTime(timezone=True), server_default=func.now())
    updated_at = db.Column(
        db.DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
