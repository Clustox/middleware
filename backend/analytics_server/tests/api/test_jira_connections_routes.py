from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from flask import Flask
from sqlalchemy.exc import IntegrityError

from mhq.api import integrations as integrations_module
from mhq.store.repos.jira_connection import (
    JiraConnectionInUseError,
    JiraConnectionNotFoundError,
)

ORG_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222"


class FakeJiraConnection:
    def __init__(self, org_id, site_url, email, provider_meta=None, generated_by=None):
        self.id = str(uuid4())
        self.org_id = org_id
        self.site_url = site_url
        self.email = email
        # Never read by the routes -- present only to prove the serializer
        # (_serialize_jira_connection) never touches it.
        self.access_token_enc_chunks = ["enc-chunk-1", "enc-chunk-2"]
        self.provider_meta = provider_meta or {}
        self.is_default = False
        self.generated_by = generated_by
        self.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)


class FakeJiraConnectionRepoService:
    """
    In-memory stand-in reproducing the three invariants the routes depend on
    from the real JiraConnectionRepoService: (org_id, site_url, email)
    uniqueness on create, delete blocked while an OrgProjectConnection
    references the row, and default-switch atomicity.
    """

    def __init__(self, connections=None, referenced_ids=None):
        self.connections = list(connections or [])
        self.referenced_ids = set(referenced_ids or [])

    def list_jira_connections(self, org_id):
        return [c for c in self.connections if str(c.org_id) == str(org_id)]

    def get_jira_connection(self, org_id, connection_id):
        for c in self.connections:
            if str(c.id) == str(connection_id) and str(c.org_id) == str(org_id):
                return c
        return None

    def create_jira_connection(
        self, org_id, site_url, email, access_token, provider_meta, generated_by
    ):
        if any(
            str(c.org_id) == str(org_id) and c.site_url == site_url and c.email == email
            for c in self.connections
        ):
            raise IntegrityError(
                "duplicate key value violates unique constraint "
                '"jira_connection_unique_account"',
                None,
                Exception(),
            )
        connection = FakeJiraConnection(
            org_id, site_url, email, provider_meta, generated_by
        )
        self.connections.append(connection)
        return connection

    def delete_jira_connection(self, org_id, connection_id):
        connection = self.get_jira_connection(org_id, connection_id)
        if not connection:
            raise JiraConnectionNotFoundError(
                f"No JiraConnection {connection_id} for org {org_id}"
            )
        if connection.id in self.referenced_ids:
            raise JiraConnectionInUseError(
                f"JiraConnection {connection_id} still has projects synced from it"
            )
        self.connections.remove(connection)

    def set_default_jira_connection(self, org_id, connection_id):
        connection = self.get_jira_connection(org_id, connection_id)
        if not connection:
            raise JiraConnectionNotFoundError(
                f"No JiraConnection {connection_id} for org {org_id}"
            )
        for c in self.connections:
            if str(c.org_id) == str(org_id) and c.id != connection.id:
                c.is_default = False
        connection.is_default = True


def _build_client():
    app = Flask(__name__)
    app.register_blueprint(integrations_module.app)
    return app.test_client()


@pytest.fixture
def routes(request):
    """
    Wires the jira-connections routes to an in-memory service. The parameter
    is a dict of {"connections": [...], "referenced_ids": [...]}.
    """
    param = getattr(request, "param", None) or {}
    service = FakeJiraConnectionRepoService(
        param.get("connections"), param.get("referenced_ids")
    )

    with patch.object(
        integrations_module, "get_query_validator", return_value=MagicMock()
    ), patch.object(
        integrations_module, "JiraConnectionRepoService", return_value=service
    ):
        yield _build_client(), service


def _list(client, org_id=ORG_ID):
    return client.get(f"/orgs/{org_id}/integrations/jira-connections")


def _create(client, site_url="acme.atlassian.net", email="a@acme.com", org_id=ORG_ID):
    return client.post(
        f"/orgs/{org_id}/integrations/jira-connections",
        json={"site_url": site_url, "email": email, "access_token": "raw-token"},
    )


def _delete(client, connection_id, org_id=ORG_ID):
    return client.delete(
        f"/orgs/{org_id}/integrations/jira-connections/{connection_id}"
    )


def _set_default(client, connection_id, org_id=ORG_ID):
    return client.patch(f"/orgs/{org_id}/integrations/jira-connections/{connection_id}")


def test_listing_is_empty_for_a_workspace_with_no_connections(routes):
    client, _ = routes

    response = _list(client)

    assert response.status_code == 200
    assert response.json == []


def test_creating_returns_201_with_the_serialized_row_and_no_token(routes):
    client, service = routes

    response = _create(client)

    assert response.status_code == 201
    body = response.json
    assert body["site_url"] == "acme.atlassian.net"
    assert body["email"] == "a@acme.com"
    assert body["is_default"] is False
    # The raw token was passed through to the service (which is what would
    # encrypt it); nothing in the response carries any form of it.
    assert "access_token" not in body
    assert "access_token_enc_chunks" not in body
    assert service.connections[0].id == body["id"]


def test_creating_a_duplicate_account_is_409(routes):
    client, service = routes
    _create(client)

    response = _create(client)

    assert response.status_code == 409
    assert len(service.connections) == 1


def test_listing_scopes_to_the_given_org(routes):
    client, _ = routes
    _create(client, site_url="ours.atlassian.net")

    ours = _list(client)
    theirs = _list(client, org_id=OTHER_ORG_ID)

    assert [c["site_url"] for c in ours.json] == ["ours.atlassian.net"]
    assert theirs.json == []


@pytest.mark.parametrize(
    "routes",
    [{"connections": [FakeJiraConnection(ORG_ID, "acme.atlassian.net", "a@acme.com")]}],
    indirect=True,
)
def test_deleting_an_unreferenced_connection_removes_it(routes):
    client, service = routes
    connection = service.connections[0]

    response = _delete(client, connection.id)

    assert response.status_code == 200
    assert service.connections == []


@pytest.mark.parametrize(
    "routes",
    [{"connections": [FakeJiraConnection(ORG_ID, "acme.atlassian.net", "a@acme.com")]}],
    indirect=True,
)
def test_deleting_a_referenced_connection_is_409_and_leaves_it_in_place(routes):
    client, service = routes
    connection = service.connections[0]
    service.referenced_ids = {connection.id}

    response = _delete(client, connection.id)

    assert response.status_code == 409
    assert service.connections == [connection]


def test_deleting_an_unknown_connection_is_404(routes):
    client, _ = routes

    assert _delete(client, str(uuid4())).status_code == 404


@pytest.mark.parametrize(
    "routes",
    [{"connections": [FakeJiraConnection(ORG_ID, "acme.atlassian.net", "a@acme.com")]}],
    indirect=True,
)
def test_deleting_from_another_workspace_is_404(routes):
    client, service = routes
    connection = service.connections[0]

    response = _delete(client, connection.id, org_id=OTHER_ORG_ID)

    assert response.status_code == 404
    assert service.connections == [connection]


def test_setting_default_on_an_unknown_connection_is_404(routes):
    client, _ = routes

    assert _set_default(client, str(uuid4())).status_code == 404


def test_setting_default_swaps_atomically(routes):
    client, service = routes
    _create(client, site_url="first.atlassian.net")
    _create(client, site_url="second.atlassian.net")
    first, second = service.connections
    service.set_default_jira_connection(ORG_ID, first.id)
    assert first.is_default is True

    response = _set_default(client, second.id)

    assert response.status_code == 200
    # Never both, never neither -- exactly the second one now.
    assert first.is_default is False
    assert second.is_default is True
