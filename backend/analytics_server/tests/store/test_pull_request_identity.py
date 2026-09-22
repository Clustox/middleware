from sqlalchemy import inspect

from mhq.store.models.code import PullRequestCommit


def test_commit_identity_is_scoped_to_its_pr():
    # CLUSTOX: the PK is what session.merge dedupes by. With hash alone as
    # the PK, two workspaces syncing the same repo made merge() silently
    # STEAL the other workspace's commit row -- rewriting its
    # pull_request_id, corrupting that org's first-commit lead time with no
    # error anywhere. (Events, whose unique key was also global, at least
    # failed loudly; found live on the server, third instance of the
    # cross-org global-unique class after OrgRepo and Incident.)
    pk_columns = {c.name for c in inspect(PullRequestCommit).primary_key}
    assert pk_columns == {"pull_request_id", "hash"}
