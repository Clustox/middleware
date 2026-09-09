from unittest.mock import MagicMock

from mhq.service.ticket_matching.service import TicketMatchingService
from mhq.store.models.code import PullRequest

# CLUSTOX: Jira integration, Phase 3 (ticket-PR matching). See
# docs/JIRA_INTEGRATION_PROPOSAL.md. The collision-resolution tests further
# down are Phase 4 (docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 5).

ORG_ID = "org-1"


def _pr(pr_id="pr-1", title="", head_branch="", body=None, repo_id="repo-1"):
    return PullRequest(
        id=pr_id,
        title=title,
        head_branch=head_branch,
        data={"body": body} if body else None,
        repo_id=repo_id,
    )


def _repo(**overrides) -> MagicMock:
    # CLUSTOX: get_colliding_ticket_key_candidates is called on every
    # match_org_prs_to_tickets run, alongside get_org_tickets_key_map --
    # defaulted to "no collisions" here so the tests below that only care
    # about the ordinary, non-colliding path don't each have to stub it.
    repo = MagicMock()
    repo.get_colliding_ticket_key_candidates.return_value = {}
    for attr, value in overrides.items():
        setattr(repo, attr, value)
    return repo


def _service(repo=None) -> TicketMatchingService:
    return TicketMatchingService(repo if repo is not None else _repo())


class TestMatchOrgPrsToTickets:
    def test_skips_fetching_prs_entirely_when_no_tickets_are_synced_yet(self):
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {}

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.get_unmatched_prs_for_org.assert_not_called()
        repo.save_mappings.assert_not_called()

    def test_does_nothing_when_there_are_no_unmatched_prs(self):
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {"PZDA-543": "ticket-1"}
        repo.get_unmatched_prs_for_org.return_value = []

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.save_mappings.assert_not_called()

    def test_maps_a_pr_to_the_ticket_its_title_references(self):
        repo = _repo()
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
        repo = _repo()
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
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {"PZDA-543": "ticket-1"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="chore: note the ISO-27001 audit date")
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.save_mappings.assert_not_called()

    # CLUSTOX: the PR title is the *only* authoritative source for a Jira
    # association -- product spec, 2026-09-10 (see TicketMatchingService's
    # own docstring). These replace an earlier version of this suite that
    # asserted the opposite: a body/branch reference used to be enough on
    # its own, on the reasoning that real data showed roughly half of
    # this org's "unmatched" PRs referenced a ticket only in the body.
    # That traded a title-shaped guarantee an admin can see and trust for
    # recall, which the product spec now explicitly rules out -- these
    # scenario numbers below refer to that spec's own numbered examples.

    def test_ignores_a_ticket_key_present_only_in_the_branch_name(self):
        # Scenario 6: branch "feature/PAY-123-payment-validation" must
        # not be used as a fallback when the title has no key at all.
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {"PAY-123": "ticket-123"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr(
                "pr-1",
                title="Improve checkout error handling",
                head_branch="feature/PAY-123-payment-validation",
            )
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.save_mappings.assert_not_called()

    def test_ignores_a_ticket_key_present_only_in_the_description(self):
        # Scenario 8: a body saying "This fixes PAY-123" must not be used
        # as a fallback when the title has no key at all.
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {"PAY-123": "ticket-123"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr(
                "pr-1",
                title="Improve checkout error handling",
                body="This fixes PAY-123.",
            )
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.save_mappings.assert_not_called()

    def test_ignores_branch_and_description_together_when_the_title_has_no_key(self):
        # Scenario 10: the combined case -- a key-free title with a real
        # key sitting in both the branch and the description at once must
        # still produce no association.
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {"PAY-123": "ticket-123"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr(
                "pr-1",
                title="Improve checkout error handling",
                head_branch="feature/checkout-errors",
                body="This fixes PAY-123.",
            )
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.save_mappings.assert_not_called()

    def test_matches_only_the_titles_key_when_branch_and_description_reference_a_different_real_ticket(
        self,
    ):
        # Scenario 14 (adapted -- this schema has no commit-message field
        # at all for a PR, so there is no code path that could scan one;
        # description is the closest real field carrying the same risk,
        # and the same guarantee must hold for it): the title's key wins,
        # full stop, even when a *different, real, currently-synced*
        # ticket key appears elsewhere on the same PR.
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {
            "PAY-123": "ticket-123",
            "PAY-456": "ticket-456",
        }
        repo.get_unmatched_prs_for_org.return_value = [
            _pr(
                "pr-1",
                title="PAY-123 Fix payment validation",
                head_branch="feature/pay-456-refactor",
                body="Related to PAY-456 refactor work.",
            )
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        mappings = repo.save_mappings.call_args[0][0]
        assert [m.ticket_id for m in mappings] == ["ticket-123"]

    def test_deduplicates_the_same_key_repeated_within_one_title(self):
        # Scenario 13: "PAY-123 Fix PAY-123 payment validation" must
        # produce exactly one mapping, not two.
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {"PAY-123": "ticket-123"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="PAY-123 Fix PAY-123 payment validation")
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        mappings = repo.save_mappings.call_args[0][0]
        assert len(mappings) == 1
        assert mappings[0].ticket_id == "ticket-123"

    def test_a_later_pr_can_match_a_ticket_an_earlier_pr_already_matched(self):
        # Scenario 12: a Jira issue can have more than one PR against it
        # over time (e.g. reopened and fixed again) -- matching must not
        # assume or enforce "one ticket, one PR". get_unmatched_prs_for_org
        # already only returns PRs with no mapping row yet, so this is
        # really a guarantee that matching doesn't skip a PR just because
        # its ticket already has a mapping from a different PR.
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {"PAY-123": "ticket-123"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-100", title="PAY-123 Initial payment fix"),
            _pr("pr-120", title="PAY-123 Fix payment regression"),
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        mappings = repo.save_mappings.call_args[0][0]
        assert {str(m.pr_id) for m in mappings} == {"pr-100", "pr-120"}
        assert {m.ticket_id for m in mappings} == {"ticket-123"}

    def test_skips_saving_entirely_when_no_pr_matches_anything(self):
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {"PZDA-543": "ticket-1"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="chore: bump dependencies")
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.save_mappings.assert_not_called()

    def test_does_one_batch_lookup_and_one_batch_save_regardless_of_pr_count(self):
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {"PZDA-543": "ticket-1"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr(f"pr-{i}", title="fix(PZDA-543): x") for i in range(50)
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.get_org_tickets_key_map.assert_called_once()
        repo.get_unmatched_prs_for_org.assert_called_once()
        repo.save_mappings.assert_called_once()
        assert len(repo.save_mappings.call_args[0][0]) == 50


# CLUSTOX: Jira multi-account support. See docs/JIRA_MULTI_ACCOUNT_PLAN.md
# Task 5 -- two connections' sites landing on the same project key ("PROJ")
# means get_org_tickets_key_map alone can no longer resolve every key to one
# ticket; these are the collision path.
class TestCollidingTicketKeys:
    def test_resolves_to_the_ticket_from_the_prs_own_relevant_connection(self):
        # The plan's own regression case: two connections both have a
        # project called "PROJ". The PR's repo is tracked by a team that
        # selected connection A's "PROJ", not connection B's -- so
        # "PROJ-123" must resolve to connection A's ticket specifically.
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {}
        repo.get_colliding_ticket_key_candidates.return_value = {
            "PROJ-123": [("ticket-a", "project-a"), ("ticket-b", "project-b")]
        }
        repo.get_relevant_org_project_ids_for_repo.return_value = {"project-a"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="fix(PROJ-123): refund rounding", repo_id="repo-1")
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        mappings = repo.save_mappings.call_args[0][0]
        assert len(mappings) == 1
        assert mappings[0].ticket_id == "ticket-a"
        repo.get_relevant_org_project_ids_for_repo.assert_called_once_with("repo-1")

    def test_skips_the_match_when_no_candidate_project_is_relevant_to_the_repo(self):
        # Fails closed: neither candidate's project is one this repo's
        # teams actually use, so there is no principled way to pick --
        # a guess here could attribute the PR to a different team's
        # ticket entirely.
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {}
        repo.get_colliding_ticket_key_candidates.return_value = {
            "PROJ-123": [("ticket-a", "project-a"), ("ticket-b", "project-b")]
        }
        repo.get_relevant_org_project_ids_for_repo.return_value = {"project-c"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="fix(PROJ-123): refund rounding")
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.save_mappings.assert_not_called()

    def test_skips_the_match_when_more_than_one_candidate_project_is_relevant(self):
        # Still ambiguous even after scoping -- e.g. one team tracks this
        # repo and has selected projects from both connections. No
        # single correct answer exists, so this stays unmatched rather
        # than picking one arbitrarily.
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {}
        repo.get_colliding_ticket_key_candidates.return_value = {
            "PROJ-123": [("ticket-a", "project-a"), ("ticket-b", "project-b")]
        }
        repo.get_relevant_org_project_ids_for_repo.return_value = {
            "project-a",
            "project-b",
        }
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="fix(PROJ-123): refund rounding")
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.save_mappings.assert_not_called()

    def test_a_key_with_no_collision_never_triggers_the_relevant_project_lookup(self):
        # The overwhelmingly common case -- no collision at all -- must
        # stay exactly as cheap as it always was: no extra query.
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {"PZDA-543": "ticket-1"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="fix(PZDA-543): x")
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.get_relevant_org_project_ids_for_repo.assert_not_called()

    def test_caches_the_relevant_project_lookup_per_repo_not_per_pr(self):
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {}
        repo.get_colliding_ticket_key_candidates.return_value = {
            "PROJ-1": [("ticket-a", "project-a"), ("ticket-b", "project-b")],
            "PROJ-2": [("ticket-c", "project-a"), ("ticket-d", "project-b")],
        }
        repo.get_relevant_org_project_ids_for_repo.return_value = {"project-a"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="fix(PROJ-1): x", repo_id="repo-1"),
            _pr("pr-2", title="fix(PROJ-2): y", repo_id="repo-1"),
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        repo.get_relevant_org_project_ids_for_repo.assert_called_once_with("repo-1")
        mappings = repo.save_mappings.call_args[0][0]
        assert {m.ticket_id for m in mappings} == {"ticket-a", "ticket-c"}

    def test_a_non_colliding_and_colliding_key_on_the_same_pr_both_resolve(self):
        repo = _repo()
        repo.get_org_tickets_key_map.return_value = {"PZDA-1": "ticket-plain"}
        repo.get_colliding_ticket_key_candidates.return_value = {
            "PROJ-1": [("ticket-a", "project-a"), ("ticket-b", "project-b")]
        }
        repo.get_relevant_org_project_ids_for_repo.return_value = {"project-a"}
        repo.get_unmatched_prs_for_org.return_value = [
            _pr("pr-1", title="fix(PZDA-1): also touches PROJ-1")
        ]

        _service(repo).match_org_prs_to_tickets(ORG_ID)

        mappings = repo.save_mappings.call_args[0][0]
        assert {m.ticket_id for m in mappings} == {"ticket-plain", "ticket-a"}
