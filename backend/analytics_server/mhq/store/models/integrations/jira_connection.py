import uuid

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import UUID, ARRAY, JSONB

from mhq.store import db


class JiraConnection(db.Model):
    """
    One connected Jira site+account for an org. Unlike Integration (one row
    per provider per org, PK (org_id, name)), an org can have many of these --
    see docs/JIRA_MULTI_ACCOUNT_PLAN.md. The legacy Integration(name="jira")
    row is untouched and unrelated to this table; there is deliberately no
    sync between the two.
    """

    __tablename__ = "JiraConnection"

    id = db.Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    org_id = db.Column(UUID(as_uuid=True), db.ForeignKey("Organization.id"))
    site_url = db.Column(db.String)
    email = db.Column(db.String)
    access_token_enc_chunks = db.Column(ARRAY(db.String))
    provider_meta = db.Column(JSONB)
    is_default = db.Column(db.Boolean, default=False)
    generated_by = db.Column(
        UUID(as_uuid=True), db.ForeignKey("Users.id"), nullable=True
    )
    created_at = db.Column(db.DateTime(timezone=True), server_default=func.now())
    updated_at = db.Column(
        db.DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    def __hash__(self):
        return hash(self.id)
