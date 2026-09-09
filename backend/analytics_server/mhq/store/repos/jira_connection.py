import re
from typing import List, Optional
from urllib.parse import urlparse

from mhq.store import db, rollback_on_exc
from mhq.store.models.integrations import JiraConnection
from mhq.store.models.projects import OrgProjectConnection
from mhq.utils.cryptography import get_crypto_service

# CLUSTOX: mirrors web-server's auth-supplementary.ts CHUNK_SIZE -- both sides
# encrypt against the same RSA keypair (mhq/config/config.ini), so the chunk
# size only needs to fit the key's OAEP message limit, not match byte-for-byte
# between languages. Kept equal anyway so a token's chunk count doesn't
# depend on which side happened to write it.
CHUNK_SIZE = 127


def _normalize_site_url(site_url: str) -> str:
    """
    A bare host, e.g. "acme.atlassian.net" -- no scheme, no trailing
    slash, matching the migration's own column comment. Enforced here,
    the one place every caller's create_jira_connection funnels through,
    rather than trusted to each caller (the web-server's connection-add
    form doesn't do this itself -- pasting a URL straight from the
    browser's address bar, e.g. "https://acme.atlassian.net/", used to be
    stored verbatim and then built into a doubly-prefixed, unreachable
    URL at search/sync time: "https://https://acme.atlassian.net//...").
    Mirrors web-server's normalizeJiraSiteUrl (src/utils/auth.ts).
    """
    trimmed = site_url.strip()
    with_scheme = (
        trimmed if re.match(r"^https?://", trimmed, re.I) else (f"https://{trimmed}")
    )
    host = urlparse(with_scheme).hostname
    return host or trimmed


class JiraConnectionInUseError(Exception):
    """
    Raised by delete_jira_connection when an OrgProjectConnection still
    references the connection. The DB FK (NO ACTION, no cascade) would
    raise its own IntegrityError anyway, but callers -- the Task 3 API
    routes -- should never let a user hit a raw constraint violation, so
    this is checked explicitly and raised first, with a message that
    names the actual problem.
    """


class JiraConnectionNotFoundError(Exception):
    """Raised when a connection_id doesn't resolve to a row for the given org_id."""


class JiraConnectionRepoService:
    """
    Store layer for JiraConnection -- one connected Jira site+account for an
    org. See docs/JIRA_MULTI_ACCOUNT_PLAN.md. Deliberately independent of
    IntegrationsRepoService/Integration: JiraConnection is a new, Jira-only,
    surrogate-keyed table, not a replacement for the legacy singleton row.
    """

    def __init__(self):
        self._db = db
        self._crypto = get_crypto_service()

    @rollback_on_exc
    def create_jira_connection(
        self,
        org_id: str,
        site_url: str,
        email: str,
        access_token: str,
        provider_meta: dict,
        generated_by: Optional[str],
    ) -> JiraConnection:
        connection = JiraConnection(
            org_id=org_id,
            site_url=_normalize_site_url(site_url),
            email=email,
            access_token_enc_chunks=self._crypto.encrypt(access_token, CHUNK_SIZE),
            provider_meta=provider_meta,
            generated_by=generated_by,
        )
        self._db.session.add(connection)
        self._db.session.commit()
        return self.get_jira_connection(org_id, str(connection.id))

    def decrypt_access_token(self, connection: JiraConnection) -> str:
        # Not @rollback_on_exc -- no DB access here, just the same decrypt
        # call CoreRepoService.get_access_token makes for Integration.
        return self._crypto.decrypt_chunks(connection.access_token_enc_chunks)

    @rollback_on_exc
    def list_jira_connections(self, org_id: str) -> List[JiraConnection]:
        return (
            self._db.session.query(JiraConnection)
            .filter(JiraConnection.org_id == org_id)
            .order_by(JiraConnection.created_at.asc())
            .all()
        )

    @rollback_on_exc
    def get_jira_connection(
        self, org_id: str, connection_id: str
    ) -> Optional[JiraConnection]:
        # Scoped by org_id, not just id -- a connection_id alone must never
        # resolve across orgs, whether the caller is a delete/set-default
        # check here or an API route trusting this as its authz boundary.
        return (
            self._db.session.query(JiraConnection)
            .filter(
                JiraConnection.id == connection_id,
                JiraConnection.org_id == org_id,
            )
            .one_or_none()
        )

    @rollback_on_exc
    def delete_jira_connection(self, org_id: str, connection_id: str) -> None:
        connection = self.get_jira_connection(org_id, connection_id)
        if not connection:
            raise JiraConnectionNotFoundError(
                f"No JiraConnection {connection_id} for org {org_id}"
            )

        still_referenced = (
            self._db.session.query(OrgProjectConnection)
            .filter(OrgProjectConnection.jira_connection_id == connection_id)
            .first()
            is not None
        )
        if still_referenced:
            raise JiraConnectionInUseError(
                f"JiraConnection {connection_id} still has projects synced "
                "from it -- unlink those projects first"
            )

        self._db.session.delete(connection)
        self._db.session.commit()

    @rollback_on_exc
    def set_default_jira_connection(self, org_id: str, connection_id: str) -> None:
        connection = self.get_jira_connection(org_id, connection_id)
        if not connection:
            raise JiraConnectionNotFoundError(
                f"No JiraConnection {connection_id} for org {org_id}"
            )

        # CLUSTOX: unset every prior default *before* setting the new one, in
        # that order, in one transaction. The partial unique index
        # (jira_connection_one_default_per_org) allows zero default rows at
        # any instant but never two -- so the intermediate state after the
        # first statement (nobody default) is legal, while the reverse order
        # (set new True first, while the old row is still True) would trip
        # the index. Both statements commit together: no window exists where
        # a reader could observe zero or two defaults.
        self._db.session.query(JiraConnection).filter(
            JiraConnection.org_id == org_id,
            JiraConnection.id != connection_id,
            JiraConnection.is_default.is_(True),
        ).update({JiraConnection.is_default: False}, synchronize_session=False)

        connection.is_default = True
        self._db.session.add(connection)
        self._db.session.commit()
