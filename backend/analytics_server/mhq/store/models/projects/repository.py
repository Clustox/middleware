import uuid

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import UUID

from mhq.store import db


class OrgProject(db.Model):
    """
    Org-level catalog of a project-tracking tool's projects (Jira, to start).

    Mirrors OrgRepo -- same "org-wide catalog, team join table" shape --
    minus the code-specific columns (default_branch, language, contributors)
    that have no equivalent for a project-tracking tool. See
    docs/JIRA_INTEGRATION_PROPOSAL.md for the phase this belongs to.
    """

    __tablename__ = "OrgProject"

    id = db.Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id = db.Column(UUID(as_uuid=True), db.ForeignKey("Organization.id"))
    key = db.Column(db.String)
    name = db.Column(db.String)
    provider = db.Column(db.String)
    idempotency_key = db.Column(db.String)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime(timezone=True), server_default=func.now())
    updated_at = db.Column(
        db.DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    def __hash__(self):
        return hash(self.id)


class TeamProjects(db.Model):
    """Join table: which OrgProject(s) a team tracks. Mirrors TeamRepos."""

    __tablename__ = "TeamProjects"

    team_id = db.Column(UUID(as_uuid=True), db.ForeignKey("Team.id"), primary_key=True)
    org_project_id = db.Column(
        UUID(as_uuid=True), db.ForeignKey("OrgProject.id"), primary_key=True
    )
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime(timezone=True), server_default=func.now())
    updated_at = db.Column(
        db.DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class RepoProjectMapping(db.Model):
    """
    Which single Jira project (if any) a repo's tickets should be
    matched against for PR<->ticket matching -- see
    docs/JIRA_INTEGRATION_PROPOSAL.md. Deliberately NOT
    TeamProjects/TeamRepos's join-table shape: org_repo_id is the sole
    primary key, not composite with org_project_id, because a repo maps
    to at most one project by design (an org's Jira setup is assumed to
    have one project's tickets live in one codebase, not scattered
    across several) -- a project can still have many repos.

    No is_active column, unlike this file's other two tables: nothing
    else references this table's rows by FK, and a stale "used to map
    to X" row serves no purpose once a repo is remapped or unmapped, so
    this is a real delete (see RepoProjectMappingRepoService.unset_mapping)
    rather than a soft one.

    Mapping is entirely optional. An unmapped repo keeps today's
    org-wide ticket-matching behavior unchanged -- see
    TicketMatchingService.match_org_prs_to_tickets.
    """

    __tablename__ = "RepoProjectMapping"

    org_repo_id = db.Column(
        UUID(as_uuid=True), db.ForeignKey("OrgRepo.id"), primary_key=True
    )
    org_project_id = db.Column(
        UUID(as_uuid=True), db.ForeignKey("OrgProject.id"), nullable=False
    )
    created_at = db.Column(db.DateTime(timezone=True), server_default=func.now())
    updated_at = db.Column(
        db.DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ProjectIssuesBookmark(db.Model):
    """
    Incremental-sync watermark for a project's issue sync, one per
    (project, provider) -- mirrors Bookmark (org repos), just scoped to
    OrgProject instead of OrgRepo. Not reusing Bookmark itself: its
    repo_id column has a real FK to OrgRepo at the DB level, so an
    OrgProject id would be rejected by that constraint.
    """

    __tablename__ = "ProjectIssuesBookmark"

    org_project_id = db.Column(
        UUID(as_uuid=True), db.ForeignKey("OrgProject.id"), primary_key=True
    )
    provider = db.Column(db.String, primary_key=True)
    bookmark = db.Column(db.String)
    created_at = db.Column(db.DateTime(timezone=True), server_default=func.now())
    updated_at = db.Column(
        db.DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
