from typing import Dict, List, Optional, Set, Tuple

from mhq.service.ticket_matching.matcher import extract_ticket_keys
from mhq.store.models.ticket_matching import PullRequestTicketMapping
from mhq.store.repos.ticket_matching import TicketMatchingRepoService
from mhq.utils.log import LOG


class TicketMatchingService:
    """
    Step 4 of docs/JIRA_INTEGRATION_PROPOSAL.md -- links a PR to the
    ticket(s) its title references. Provider-agnostic on purpose: this
    only reads already-synced PullRequest/Ticket rows, so it doesn't need
    an ETL-handler-per-provider the way the Jira/GitHub/GitLab syncs do --
    there's no external API variability to abstract over here, just
    internal data already in our own DB.

    CLUSTOX: the PR title is the *only* authoritative source for this
    association -- branch name, description/body, and commit messages
    are deliberately never scanned, even though extract_ticket_keys
    itself is happy to take more than one text and a real ticket key can
    genuinely appear in any of them. A title-only PR ("Improve checkout
    error handling") whose branch is "feature/PAY-123-..." or whose body
    says "Closes PAY-123" must stay unlinked -- see the product
    requirement this enforces (Jira multi-account support work,
    2026-09-10) for the full spec and its worked examples. An earlier
    version of this method also scanned head_branch and description,
    on the reasoning that real data showed PRs referencing a ticket only
    in the body; that traded correctness (a title-shaped guarantee an
    admin can see and trust) for recall, which the product spec now
    explicitly rules out.
    """

    def __init__(self, repo_service: TicketMatchingRepoService):
        self._repo = repo_service

    def match_org_prs_to_tickets(self, org_id: str) -> None:
        # One batch lookup for every ticket in the org, one batch lookup
        # for the (normally empty) set of colliding keys, and one batch
        # fetch for every PR that doesn't have a mapping yet -- matching
        # itself is then pure in-memory work (regex + dict lookups), not
        # a query per PR. See docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 5 for
        # why colliding keys are looked up separately from the main map.
        ticket_id_by_key = self._repo.get_org_tickets_key_map(org_id)
        colliding_candidates = self._repo.get_colliding_ticket_key_candidates(org_id)
        if not ticket_id_by_key and not colliding_candidates:
            LOG.info(f"No tickets synced yet for org {org_id}, skipping PR matching")
            return

        unmatched_prs = self._repo.get_unmatched_prs_for_org(org_id)
        if not unmatched_prs:
            return

        # Relevant-project-ids is itself a query (see
        # get_relevant_org_project_ids_for_repo) -- cached per repo_id so
        # N unmatched PRs from the same repo, each referencing a colliding
        # key, cost one lookup, not N.
        relevant_project_ids_by_repo: Dict[str, Set[str]] = {}

        # Title only -- see this class's own docstring for why branch name
        # and description are deliberately never passed here.
        # extract_ticket_keys' own filter-against-real-keys step (the `if
        # key in ticket_id_by_key` check below) is what keeps something
        # merely key-shaped in the title (e.g. "ISO-27001") from becoming
        # a false match.
        mappings = []
        for pr in unmatched_prs:
            for key in extract_ticket_keys(pr.title):
                ticket_id = ticket_id_by_key.get(key)
                if ticket_id is None:
                    candidates = colliding_candidates.get(key)
                    if not candidates:
                        continue
                    ticket_id = self._resolve_colliding_key(
                        pr, candidates, relevant_project_ids_by_repo
                    )
                    if ticket_id is None:
                        continue
                mappings.append(
                    PullRequestTicketMapping(pr_id=pr.id, ticket_id=ticket_id)
                )
        if not mappings:
            return

        self._repo.save_mappings(mappings)
        LOG.info(f"Matched {len(mappings)} PR-ticket link(s) for org {org_id}")

    def _resolve_colliding_key(
        self,
        pr,
        candidates: List[Tuple[str, str]],
        relevant_project_ids_by_repo: Dict[str, Set[str]],
    ) -> Optional[str]:
        """
        candidates is every (ticket_id, org_project_id) sharing this key
        org-wide -- two or more, by construction (see
        get_colliding_ticket_key_candidates). Disambiguates using the
        project(s) actually relevant to the PR's own repo (its tracking
        team's selected projects); if that still doesn't narrow it to
        exactly one, fails closed -- no match, rather than a guess that
        could silently attribute a PR to another team's ticket.
        """
        repo_id = str(pr.repo_id)
        if repo_id not in relevant_project_ids_by_repo:
            relevant_project_ids_by_repo[repo_id] = (
                self._repo.get_relevant_org_project_ids_for_repo(repo_id)
            )
        relevant_project_ids = relevant_project_ids_by_repo[repo_id]

        matches = [
            ticket_id
            for ticket_id, org_project_id in candidates
            if org_project_id in relevant_project_ids
        ]
        return matches[0] if len(matches) == 1 else None


def get_ticket_matching_service() -> TicketMatchingService:
    return TicketMatchingService(TicketMatchingRepoService())


def match_tickets_to_prs(org_id: str) -> None:
    get_ticket_matching_service().match_org_prs_to_tickets(org_id)
