from typing import Dict, List

from mhq.service.ticket_matching.matcher import extract_ticket_keys
from mhq.store.models.code import PullRequest
from mhq.store.models.ticket_matching import PullRequestTicketMapping
from mhq.store.repos.repo_project_mapping import RepoProjectMappingRepoService
from mhq.store.repos.ticket_matching import TicketMatchingRepoService
from mhq.utils.log import LOG


class TicketMatchingService:
    """
    Step 4 of docs/JIRA_INTEGRATION_PROPOSAL.md -- links a PR to the
    ticket(s) its title/branch name reference. Provider-agnostic on
    purpose: this only reads already-synced PullRequest/Ticket rows, so
    it doesn't need an ETL-handler-per-provider the way the Jira/GitHub/
    GitLab syncs do -- there's no external API variability to abstract
    over here, just internal data already in our own DB.
    """

    def __init__(
        self,
        repo_service: TicketMatchingRepoService,
        repo_project_mapping_repo: RepoProjectMappingRepoService,
    ):
        self._repo = repo_service
        self._repo_project_mapping_repo = repo_project_mapping_repo

    def match_org_prs_to_tickets(self, org_id: str) -> None:
        # One batch lookup for every ticket in the org, and one batch
        # fetch for every PR that doesn't have a mapping yet -- matching
        # itself is then pure in-memory work (regex + dict lookups), not
        # a query per PR.
        org_ticket_id_by_key = self._repo.get_org_tickets_key_map(org_id)
        if not org_ticket_id_by_key:
            LOG.info(f"No tickets synced yet for org {org_id}, skipping PR matching")
            return

        unmatched_prs = self._repo.get_unmatched_prs_for_org(org_id)
        if not unmatched_prs:
            return

        # CLUSTOX: repo -> project mapping (docs/JIRA_INTEGRATION_PROPOSAL.md,
        # "Repo <-> Project Mapping"). A repo with an explicit mapping only
        # matches tickets from that one project; an unmapped repo keeps the
        # org-wide behavior this method has always had -- mapping is
        # optional, not a breaking change for teams that haven't set it.
        repo_ids = list({str(pr.repo_id) for pr in unmatched_prs})
        mapped_project_id_by_repo = (
            self._repo_project_mapping_repo.get_mapping_for_repos(repo_ids)
        )
        # Built lazily, one query per distinct *mapped* project actually
        # hit by this batch of PRs -- most orgs will have zero or a
        # handful of mapped repos, not worth querying every mapped
        # project up front regardless of whether any of its repos have
        # unmatched PRs this cycle.
        ticket_id_by_key_by_project: Dict[str, Dict[str, str]] = {}

        def _ticket_map_for(pr: PullRequest) -> Dict[str, str]:
            project_id = mapped_project_id_by_repo.get(str(pr.repo_id))
            if not project_id:
                return org_ticket_id_by_key
            if project_id not in ticket_id_by_key_by_project:
                ticket_id_by_key_by_project[project_id] = (
                    self._repo.get_tickets_key_map_for_project(project_id)
                )
            return ticket_id_by_key_by_project[project_id]

        # Real data: ~half of this org's "unmatched" PRs actually
        # reference a real, valid ticket key -- just in the PR body
        # (e.g. under a "Linked Issue(s)" section), never in the title
        # or branch that this used to check alone. extract_ticket_keys'
        # own filter-against-real-keys step (the `if key in ticket_map`
        # below) is what keeps something merely key-shaped in a long
        # description (a version string, a spec reference) from becoming
        # a false match -- scanning more text doesn't weaken that
        # guarantee.
        mappings: List[PullRequestTicketMapping] = []
        for pr in unmatched_prs:
            ticket_map = _ticket_map_for(pr)
            for key in extract_ticket_keys(pr.title, pr.head_branch, pr.description):
                if key in ticket_map:
                    mappings.append(
                        PullRequestTicketMapping(
                            pr_id=pr.id, ticket_id=ticket_map[key]
                        )
                    )

        if not mappings:
            return

        self._repo.save_mappings(mappings)
        LOG.info(f"Matched {len(mappings)} PR-ticket link(s) for org {org_id}")


def get_ticket_matching_service() -> TicketMatchingService:
    return TicketMatchingService(
        TicketMatchingRepoService(), RepoProjectMappingRepoService()
    )


def match_tickets_to_prs(org_id: str) -> None:
    get_ticket_matching_service().match_org_prs_to_tickets(org_id)
