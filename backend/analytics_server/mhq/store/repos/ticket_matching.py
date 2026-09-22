from datetime import datetime
from typing import Dict, List, Set, Tuple

from sqlalchemy import func
from sqlalchemy.orm import defer

from mhq.store import db, rollback_on_exc
from mhq.store.models.code import OrgRepo, PullRequest, PullRequestState
from mhq.store.models.code.repository import TeamRepos
from mhq.store.models.projects import OrgProject, TeamProjects, Ticket
from mhq.store.models.ticket_matching import PullRequestTicketMapping


class TicketMatchingRepoService:
    def __init__(self):
        self._db = db

    def _ticket_candidates_by_key(
        self, org_id: str
    ) -> Dict[str, List[Tuple[str, str]]]:
        """
        Every (ticket_id, org_project_id) synced for this org, grouped by
        uppercased ticket key -- not scoped to a project's is_active (a
        ticket that was already synced should stay matchable even if its
        project is later deselected). One query; get_org_tickets_key_map
        and get_colliding_ticket_key_candidates both group its result in
        memory rather than each querying the tickets table themselves.
        """
        rows = (
            self._db.session.query(Ticket.id, Ticket.key, Ticket.org_project_id)
            .join(OrgProject, Ticket.org_project_id == OrgProject.id)
            .filter(OrgProject.org_id == org_id)
            .all()
        )
        by_key: Dict[str, List[Tuple[str, str]]] = {}
        for ticket_id, key, org_project_id in rows:
            by_key.setdefault(key.upper(), []).append(
                (str(ticket_id), str(org_project_id))
            )
        return by_key

    @rollback_on_exc
    def get_org_tickets_key_map(self, org_id: str) -> Dict[str, str]:
        """
        Uppercased ticket key -> ticket id, for every key that maps to
        exactly one ticket org-wide -- the overwhelmingly common case,
        and the only one multi-account Jira (docs/JIRA_MULTI_ACCOUNT_PLAN.md)
        changes nothing about. A key two or more tickets share (two
        connections' sites landing on the same project key -- "Known
        risks" #2 in that plan) is deliberately excluded here rather than
        resolved to "whichever the query happened to return last", which
        is what silently mismatched a PR to the wrong connection's ticket
        before this existed. get_colliding_ticket_key_candidates is what
        TicketMatchingService uses to resolve those, per PR.
        """
        by_key = self._ticket_candidates_by_key(org_id)
        return {
            key: candidates[0][0]
            for key, candidates in by_key.items()
            if len(candidates) == 1
        }

    @rollback_on_exc
    def get_colliding_ticket_key_candidates(
        self, org_id: str
    ) -> Dict[str, List[Tuple[str, str]]]:
        """
        Uppercased ticket key -> [(ticket_id, org_project_id), ...], for
        every key shared by two or more tickets in this org. See
        get_org_tickets_key_map's own docstring for why these are held
        back from the main map.
        """
        by_key = self._ticket_candidates_by_key(org_id)
        return {key: c for key, c in by_key.items() if len(c) > 1}

    @rollback_on_exc
    def get_relevant_org_project_ids_for_repo(self, repo_id: str) -> Set[str]:
        """
        Project ids selected (TeamProjects) by any team that also tracks
        this repo (TeamRepos) -- used only to disambiguate a ticket-key
        collision across connections (get_colliding_ticket_key_candidates
        above), never as the default matching scope. Matching stays
        org-wide otherwise: scoping every PR to its repo's teams' projects
        by default would break the existing, deliberate "stay matchable
        even if the project was since deselected" guarantee for the
        overwhelming majority of orgs that never have a colliding key at
        all. See docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 5.
        """
        rows = (
            self._db.session.query(TeamProjects.org_project_id)
            .join(TeamRepos, TeamRepos.team_id == TeamProjects.team_id)
            .filter(
                TeamRepos.org_repo_id == repo_id,
                TeamRepos.is_active.is_(True),
                TeamProjects.is_active.is_(True),
            )
            .distinct()
            .all()
        )
        return {str(project_id) for (project_id,) in rows}

    @rollback_on_exc
    def get_unmatched_prs_for_org(self, org_id: str) -> List[PullRequest]:
        """
        PRs for this org with no PullRequestTicketMapping row yet. Not
        "not yet closed" or "recently updated" -- a PR that genuinely
        references no ticket gets re-scanned every cycle (cheap: no API
        calls, just a regex against PullRequest.title), but a PR whose
        match was already found never gets re-queried.

        data (which holds description/body) is deferred here, same as
        get_unlinked_merged_prs below -- matching only ever reads
        PullRequest.title, its own plain column (see
        TicketMatchingService's own docstring for why description and
        head_branch are deliberately never scanned), so there's no
        reason to pull a potentially large JSONB blob off every unmatched
        PR just to leave it unused.
        """
        return (
            self._db.session.query(PullRequest)
            .join(OrgRepo, PullRequest.repo_id == OrgRepo.id)
            .outerjoin(
                PullRequestTicketMapping,
                PullRequestTicketMapping.pr_id == PullRequest.id,
            )
            .filter(
                OrgRepo.org_id == org_id,
                PullRequestTicketMapping.pr_id.is_(None),
            )
            .options(defer(PullRequest.data))
            .all()
        )

    @rollback_on_exc
    def save_mappings(self, mappings: List[PullRequestTicketMapping]):
        [self._db.session.merge(mapping) for mapping in mappings]
        self._db.session.commit()

    @rollback_on_exc
    def get_unlinked_merged_pr_count(
        self, repo_ids: List[str], from_time: datetime, to_time: datetime
    ) -> int:
        """
        How many PRs merged in [from_time, to_time] across these repos
        have no PullRequestTicketMapping row -- the data-hygiene callout
        in docs/JIRA_INTEGRATION_PROPOSAL.md §6E. A single count query,
        not "fetch all merged PRs and count client-side".
        """
        if not repo_ids:
            return 0

        return self._unlinked_merged_prs_query(repo_ids, from_time, to_time).count()

    @rollback_on_exc
    def get_unlinked_merged_prs(
        self, repo_ids: List[str], from_time: datetime, to_time: datetime
    ) -> List[PullRequest]:
        """
        The actual rows behind get_unlinked_merged_pr_count -- the
        drill-down a person needs to see *which* PRs fell through the
        ticket-key regex (a typo, a non-standard branch name, or a PR
        that genuinely never referenced a ticket) rather than just how
        many. Same filter, same bounded window; only the projection and
        `.all()` vs `.count()` differ, so the two can never disagree
        about which PRs qualify.
        """
        if not repo_ids:
            return []

        return (
            self._unlinked_merged_prs_query(repo_ids, from_time, to_time)
            .options(defer(PullRequest.data))
            .order_by(PullRequest.state_changed_at.desc())
            .all()
        )

    @rollback_on_exc
    def get_ticket_created_at_by_pr_ids(self, pr_ids: List[str]) -> Dict[str, datetime]:
        """
        For PRs that already have a PullRequestTicketMapping row, the
        earliest linked ticket's created_at, keyed by pr_id -- the
        extended Lead Time breakdown's "idea was written up" anchor
        (docs/JIRA_INTEGRATION_PROPOSAL.md §6A). A PR can reference more
        than one ticket (real data: "PZDA-544/546" in one title) -- the
        *earliest* ticket is the right anchor for an idea-to-production
        span, not an arbitrary or last one. One batched query, not one
        per PR.
        """
        if not pr_ids:
            return {}

        rows = (
            self._db.session.query(
                PullRequestTicketMapping.pr_id, func.min(Ticket.created_at)
            )
            .join(Ticket, Ticket.id == PullRequestTicketMapping.ticket_id)
            .filter(PullRequestTicketMapping.pr_id.in_(pr_ids))
            .group_by(PullRequestTicketMapping.pr_id)
            .all()
        )
        return {str(pr_id): created_at for pr_id, created_at in rows}

    def _unlinked_merged_prs_query(
        self, repo_ids: List[str], from_time: datetime, to_time: datetime
    ):
        return (
            self._db.session.query(PullRequest)
            .outerjoin(
                PullRequestTicketMapping,
                PullRequestTicketMapping.pr_id == PullRequest.id,
            )
            .filter(
                PullRequest.repo_id.in_(repo_ids),
                PullRequest.state == PullRequestState.MERGED,
                PullRequest.state_changed_at.between(from_time, to_time),
                PullRequestTicketMapping.pr_id.is_(None),
            )
        )
