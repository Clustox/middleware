from unittest.mock import MagicMock

from mhq.service.ticket_matching.service import TicketMatchingService
from mhq.store.models.code import PullRequest

# CLUSTOX: Jira integration, Phase 3 (ticket-PR matching). See
# docs/JIRA_INTEGRATION_PROPOSAL.md.

ORG_ID = "org-1"


def _pr(pr_id="pr-1", title="", head_branch="", body=None, repo_id="repo-1"):
    return PullRequest(
        id=pr_id,
        repo_id=repo_id,
        title=title,
        head_branch=head_branch,
        data={"body": body} if body else None,
    )


def _mapping_repo(mapping=None) -> MagicMock:
    # CLUSTOX: Repo <-> Project Mapping (docs/JIRA_INTEGRATION_PROPOSAL.md).
    # Defaults to "nothing mapped" so every pre-existing test in this file
    # -- written before repo/project mapping existed -- keeps exercising
    # the exact org-wide fallback behavior it always has, unchanged.
    repo = MagicMock()
    repo.get_mapping_for_repos.return_value = mapping or {}
    return repo


def _service(repo=None, repo_project_mapping_repo=None) -> TicketMatchingService:
    return TicketMatchingService(
        repo or MagicMock(), repo_project_mapping_repo or _mapping_repo()
    )


class TestMatchOrgPrsToTickets:
    def test_skips_fetching_prs_entirely_when_no_tickets_are_synced_yet(self):
        repo = MagicMock()
        repo.get_org_tickets_key_map.return_value = {}

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.get_unmatched_prs_for_org.assert_not_called()
        repo.save_mappings.assert_not_called()

    def test_does_nothing_when_there_are_no_unmatched_prs(self):
        repo = MagicMock()
        repo.get_org_tickets_key_map.return_value = {"PZDA-543": "ticket-1"}
        repo.get_unmatched_prs_for_org.return_value = []

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.save_mappings.assert_not_called()

    def test_maps_a_pr_to_the_ticket_its_title_references(self):
        repo = MagicMock()
        repo.get_org_tickets_key_map.return_value = {"PZDA-543": "ticket-1"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="fix(PZDA-543): consent policy version")
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        mappings = repo.save_mappings.call_args[0][0]
        assert len(mappings) == 1
        assert str(mappings[0].pr_id) == "pr-1"
        assert mappings[0].ticket_id == "ticket-1"

    def test_maps_a_pr_to_every_ticket_a_multi_ticket_title_references(self):
        repo = MagicMock()
        repo.get_org_tickets_key_map.return_value = {
            "PZDA-544": "ticket-544",
            "PZDA-546": "ticket-546",
        }
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="feat(PZDA-544/546): reminder interval")
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        mappings = repo.save_mappings.call_args[0][0]
        assert {m.ticket_id for m in mappings} == {"ticket-544", "ticket-546"}

    def test_does_not_match_a_key_shaped_string_that_is_not_a_real_ticket(self):
        # The regex would extract "ISO-27001" as a candidate; since it's
        # not in the org's real ticket key map, it must not become a
        # mapping row.
        repo = MagicMock()
        repo.get_org_tickets_key_map.return_value = {"PZDA-543": "ticket-1"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="chore: note the ISO-27001 audit date")
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.save_mappings.assert_not_called()

    def test_matches_a_pr_to_a_ticket_referenced_only_in_its_body(self):
        # Real data: about half of this org's "unmatched" PRs turned
        # out to reference a real ticket only in the body -- e.g. under
        # a "Linked Issue(s)" section -- never in the title or branch.
        repo = MagicMock()
        repo.get_org_tickets_key_map.return_value = {"PZDA-689": "ticket-689"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr(
                "pr-1",
                title="fix(charges): dispute never created",
                head_branch="fix/charge-dispute",
                body="## Linked Issue(s)\r\nCloses PZDA-689",
            )
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        mappings = repo.save_mappings.call_args[0][0]
        assert len(mappings) == 1
        assert mappings[0].ticket_id == "ticket-689"

    def test_does_not_match_a_key_shaped_string_in_the_body_that_is_not_a_real_ticket(
        self,
    ):
        # A long PR description referencing e.g. "SHA-256" or "RELEASE-2"
        # must not become a false match, same guarantee as for
        # title/branch.
        repo = MagicMock()
        repo.get_org_tickets_key_map.return_value = {"PZDA-543": "ticket-1"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr(
                "pr-1",
                title="chore: rotate secrets",
                body="Switched hashing to SHA-256 per RELEASE-2 notes",
            )
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.save_mappings.assert_not_called()

    def test_skips_saving_entirely_when_no_pr_matches_anything(self):
        repo = MagicMock()
        repo.get_org_tickets_key_map.return_value = {"PZDA-543": "ticket-1"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="chore: bump dependencies")
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.save_mappings.assert_not_called()

    def test_does_one_batch_lookup_and_one_batch_save_regardless_of_pr_count(self):
        repo = MagicMock()
        repo.get_org_tickets_key_map.return_value = {"PZDA-543": "ticket-1"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr(f"pr-{i}", title="fix(PZDA-543): x") for i in range(50)
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.get_org_tickets_key_map.assert_called_once()
        repo.get_unmatched_prs_for_org.assert_called_once()
        repo.save_mappings.assert_called_once()
        assert len(repo.save_mappings.call_args[0][0]) == 50


class TestRepoProjectMappingScoping:
    """
    Repo <-> Project Mapping (docs/JIRA_INTEGRATION_PROPOSAL.md). A repo
    with an explicit mapping only matches tickets from that one project;
    an unmapped repo keeps the pre-existing org-wide behavior.
    """

    def test_unmapped_repo_still_matches_against_the_full_org_wide_ticket_map(self):
        repo = MagicMock()
        repo.get_org_tickets_key_map.return_value = {"PROJA-1": "ticket-a1"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="fix(PROJA-1): x", repo_id="repo-unmapped")
        ]
        mapping_repo = _mapping_repo(mapping={})

        _service(repo, mapping_repo).match_org_prs_to_tickets(ORG_ID)

        mappings = repo.save_mappings.call_args[0][0]
        assert len(mappings) == 1
        assert mappings[0].ticket_id == "ticket-a1"
        repo.get_tickets_key_map_for_project.assert_not_called()

    def test_mapped_repo_only_matches_tickets_from_its_own_project(self):
        repo = MagicMock()
        repo.get_org_tickets_key_map.return_value = {
            "PROJA-1": "ticket-a1",
            "PROJB-1": "ticket-b1",
        }
        repo.get_tickets_key_map_for_project.return_value = {"PROJA-1": "ticket-a1"}
        # A PR in a repo mapped to project A, whose title happens to also
        # reference a key from project B -- the cross-project key must
        # not match, since it isn't in project A's own key map.
        repo.get_unmatched_prs_for_org.return_value = [
            _pr(
                "pr-1",
                title="fix(PROJA-1): also mentions PROJB-1 in passing",
                repo_id="repo-mapped-a",
            )
        ]
        mapping_repo = _mapping_repo(mapping={"repo-mapped-a": "project-a"})

        _service(repo, mapping_repo).match_org_prs_to_tickets(ORG_ID)

        mappings = repo.save_mappings.call_args[0][0]
        assert len(mappings) == 1
        assert mappings[0].ticket_id == "ticket-a1"
        repo.get_tickets_key_map_for_project.assert_called_once_with("project-a")

    def test_two_prs_in_the_same_mapped_repo_only_query_that_projects_key_map_once(
        self,
    ):
        repo = MagicMock()
        repo.get_org_tickets_key_map.return_value = {"PROJA-1": "ticket-a1"}
        repo.get_tickets_key_map_for_project.return_value = {"PROJA-1": "ticket-a1"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="fix(PROJA-1): x", repo_id="repo-mapped-a"),
            _pr("pr-2", title="fix(PROJA-1): y", repo_id="repo-mapped-a"),
        ]
        mapping_repo = _mapping_repo(mapping={"repo-mapped-a": "project-a"})

        _service(repo, mapping_repo).match_org_prs_to_tickets(ORG_ID)

        repo.get_tickets_key_map_for_project.assert_called_once_with("project-a")

    def test_a_project_mapped_repos_pr_does_not_fall_back_to_the_org_wide_map(self):
        # The whole point of mapping: a key that's real in the org, and
        # would have matched under the old org-wide behavior, must NOT
        # match once its repo is mapped to a project that key isn't in.
        repo = MagicMock()
        repo.get_org_tickets_key_map.return_value = {"PROJB-1": "ticket-b1"}
        repo.get_tickets_key_map_for_project.return_value = {}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="fix(PROJB-1): x", repo_id="repo-mapped-a")
        ]
        mapping_repo = _mapping_repo(mapping={"repo-mapped-a": "project-a"})

        _service(repo, mapping_repo).match_org_prs_to_tickets(ORG_ID)

        repo.save_mappings.assert_not_called()
