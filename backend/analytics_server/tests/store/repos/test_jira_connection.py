from unittest.mock import MagicMock, patch

import pytest

from mhq.store.repos.jira_connection import (
    CHUNK_SIZE,
    JiraConnectionInUseError,
    JiraConnectionNotFoundError,
    JiraConnectionRepoService,
    _normalize_site_url,
)


def _service_with_mock_db() -> (JiraConnectionRepoService, MagicMock):
    db = MagicMock()
    with patch("mhq.store.repos.jira_connection.get_crypto_service") as mock_get_crypto:
        service = JiraConnectionRepoService()
    service._db = db
    service._crypto = mock_get_crypto.return_value
    return service, db


class TestCreateJiraConnection:
    def test_encrypts_the_token_and_returns_the_saved_row(self):
        service, db = _service_with_mock_db()
        service._crypto.encrypt.return_value = ["chunk1", "chunk2"]
        saved = MagicMock()
        with patch.object(service, "get_jira_connection", return_value=saved):
            result = service.create_jira_connection(
                "org-1",
                "acme.atlassian.net",
                "person@acme.com",
                "plain-text-token",
                {"foo": "bar"},
                "user-1",
            )

        # The raw token is never persisted -- only encrypt()'s output goes
        # onto the model, and it goes through the same CHUNK_SIZE the
        # web-server side uses.
        service._crypto.encrypt.assert_called_once_with("plain-text-token", CHUNK_SIZE)
        added = db.session.add.call_args[0][0]
        assert added.access_token_enc_chunks == ["chunk1", "chunk2"]
        assert added.org_id == "org-1"
        assert added.site_url == "acme.atlassian.net"
        assert added.email == "person@acme.com"
        db.session.commit.assert_called_once()
        assert result is saved

    def test_normalizes_a_url_pasted_straight_from_the_browser(self):
        # The regression this guards: a value like this stored verbatim
        # used to build "https://https://acme.atlassian.net//..." at
        # search/sync time -- unreachable, and the failure mode a real
        # user actually hit.
        service, db = _service_with_mock_db()
        service._crypto.encrypt.return_value = ["chunk"]
        with patch.object(service, "get_jira_connection", return_value=MagicMock()):
            service.create_jira_connection(
                "org-1",
                "https://acme.atlassian.net/",
                "person@acme.com",
                "token",
                {},
                None,
            )

        added = db.session.add.call_args[0][0]
        assert added.site_url == "acme.atlassian.net"

    def test_normalizes_a_bare_host_to_itself(self):
        service, db = _service_with_mock_db()
        service._crypto.encrypt.return_value = ["chunk"]
        with patch.object(service, "get_jira_connection", return_value=MagicMock()):
            service.create_jira_connection(
                "org-1", "acme.atlassian.net", "p@acme.com", "token", {}, None
            )

        added = db.session.add.call_args[0][0]
        assert added.site_url == "acme.atlassian.net"


class TestNormalizeSiteUrl:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("acme.atlassian.net", "acme.atlassian.net"),
            ("https://acme.atlassian.net", "acme.atlassian.net"),
            ("https://acme.atlassian.net/", "acme.atlassian.net"),
            ("HTTPS://ACME.atlassian.net/", "acme.atlassian.net"),
            ("  acme.atlassian.net  ", "acme.atlassian.net"),
            ("http://acme.atlassian.net/jira/", "acme.atlassian.net"),
        ],
    )
    def test_strips_scheme_case_whitespace_and_trailing_path(self, raw, expected):
        assert _normalize_site_url(raw) == expected


class TestListJiraConnections:
    def test_filters_by_org_id(self):
        service, db = _service_with_mock_db()

        service.list_jira_connections("org-1")

        db.session.query.return_value.filter.assert_called_once()
        db.session.query.return_value.filter.return_value.order_by.return_value.all.assert_called_once()


class TestGetJiraConnection:
    def test_scopes_by_both_id_and_org_id(self):
        service, db = _service_with_mock_db()

        service.get_jira_connection("org-1", "conn-1")

        filter_args = db.session.query.return_value.filter.call_args[0]
        assert len(filter_args) == 2


class TestDeleteJiraConnection:
    def test_raises_not_found_when_connection_does_not_belong_to_org(self):
        service, db = _service_with_mock_db()
        with patch.object(service, "get_jira_connection", return_value=None):
            with pytest.raises(JiraConnectionNotFoundError):
                service.delete_jira_connection("org-1", "conn-1")

        db.session.delete.assert_not_called()

    def test_raises_in_use_when_an_org_project_connection_still_references_it(self):
        service, db = _service_with_mock_db()
        connection = MagicMock()
        db.session.query.return_value.filter.return_value.first.return_value = (
            MagicMock()
        )

        with patch.object(service, "get_jira_connection", return_value=connection):
            with pytest.raises(JiraConnectionInUseError):
                service.delete_jira_connection("org-1", "conn-1")

        db.session.delete.assert_not_called()
        db.session.commit.assert_not_called()

    def test_deletes_when_unreferenced(self):
        service, db = _service_with_mock_db()
        connection = MagicMock()
        db.session.query.return_value.filter.return_value.first.return_value = None

        with patch.object(service, "get_jira_connection", return_value=connection):
            service.delete_jira_connection("org-1", "conn-1")

        db.session.delete.assert_called_once_with(connection)
        db.session.commit.assert_called_once()


class TestSetDefaultJiraConnection:
    def test_raises_not_found_when_connection_does_not_belong_to_org(self):
        service, db = _service_with_mock_db()
        with patch.object(service, "get_jira_connection", return_value=None):
            with pytest.raises(JiraConnectionNotFoundError):
                service.set_default_jira_connection("org-1", "conn-1")

        db.session.commit.assert_not_called()

    def test_unsets_prior_defaults_before_setting_the_new_one(self):
        # The regression this guards: reversing the order (set new True
        # first, unset old second) would momentarily have two default rows
        # in the same transaction and violate
        # jira_connection_one_default_per_org's own invariant even before
        # the DB gets a chance to enforce it.
        service, db = _service_with_mock_db()
        connection = MagicMock(is_default=False)
        calls = []
        db.session.query.return_value.filter.return_value.update.side_effect = (
            lambda *a, **k: calls.append("unset")
        )
        db.session.commit.side_effect = lambda: calls.append("commit")

        with patch.object(service, "get_jira_connection", return_value=connection):
            service.set_default_jira_connection("org-1", "conn-1")

        assert calls == ["unset", "commit"]
        assert connection.is_default is True
        db.session.commit.assert_called_once()

    def test_excludes_the_target_connection_from_the_unset_filter(self):
        service, db = _service_with_mock_db()
        connection = MagicMock(is_default=False, id="conn-1")

        with patch.object(service, "get_jira_connection", return_value=connection):
            service.set_default_jira_connection("org-1", "conn-1")

        filter_args = db.session.query.return_value.filter.call_args[0]
        # org scoping, "not this row", and "currently default" -- all three,
        # or an unscoped update could flip defaults across orgs or reset a
        # connection that was never default in the first place.
        assert len(filter_args) == 3
