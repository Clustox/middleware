"""
Seeds a fully isolated test team -- N fake repos, N fake Jira projects,
and data for every DORA metric + every Jira widget in the app -- so
nothing needs a working GitHub/Jira token or a live external API call.
Every row is written directly to the database.

CLUSTOX: built for local/dev verification of the Jira integration
(docs/JIRA_INTEGRATION_PROPOSAL.md) without touching a real repo or a
real Jira site. Safe to re-run against a different org; it refuses to
re-seed a team name that already exists rather than duplicating data.

Run inside the app container, where the app's own venv + models + DB
connection already exist:

    docker cp scripts/seed_dummy_dora_data.py middleware-dev:/app/backend/analytics_server/
    docker exec middleware-dev /opt/venv/bin/python \
        /app/backend/analytics_server/seed_dummy_dora_data.py --org-id <ORG_ID>

Options (see --help): --org-id (required), --team-name, --repos,
--projects, --prs-per-repo, --tickets-per-project, --dump-path.
"""
import argparse
import json
import random
from datetime import datetime, timedelta, timezone

from flask import Flask

from env import load_app_env

load_app_env()

from mhq.store import configure_db_with_app, db  # noqa: E402
from mhq.store.models.code import OrgRepo, PullRequest, TeamRepos  # noqa: E402
from mhq.store.models.code.enums import PullRequestState, TeamReposDeploymentType  # noqa: E402
from mhq.store.models.core import Team  # noqa: E402
from mhq.store.models.incidents import (  # noqa: E402
    Incident,
    IncidentOrgIncidentServiceMap,
    IncidentProvider,
    IncidentSource,
    IncidentStatus,
    IncidentType,
    OrgIncidentService,
    TeamIncidentService,
)
from mhq.store.models.projects import (  # noqa: E402
    OrgProject,
    Sprint,
    TeamProjects,
    Ticket,
    TicketState,
)
from mhq.store.models.ticket_matching import PullRequestTicketMapping  # noqa: E402
from mhq.utils.string import uuid4_str  # noqa: E402

AUTHORS = ["asha.kumar", "leo.martins", "priya.raghavan", "sam.oduya"]
STATUS_CATEGORIES = ["To Do", "In Progress", "Done"]
ISSUE_TYPES = ["Story", "Task", "Bug"]

REPO_NAMES = ["test-repo-alpha", "test-repo-beta", "test-repo-gamma", "test-repo-delta", "test-repo-epsilon"]
PROJECT_SPECS = [
    ("DUMMYA", "Dummy Project Alpha"),
    ("DUMMYB", "Dummy Project Beta"),
    ("DUMMYC", "Dummy Project Gamma"),
    ("DUMMYD", "Dummy Project Delta"),
    ("DUMMYE", "Dummy Project Epsilon"),
]

now = datetime.now(timezone.utc)


def days_ago(n, hour=10):
    return (now - timedelta(days=n)).replace(hour=hour, minute=0, second=0, microsecond=0)


def make_app() -> Flask:
    app = Flask(__name__)
    configure_db_with_app(app)
    return app


def seed_repo(org_id, team_id, repo_name, idx, prs_per_repo):
    # CLUSTOX: OrgRepo has a unique constraint on (org_name, name,
    # provider) -- global, not scoped per org_id (a real repo slug is
    # meant to be unique platform-wide). org_name has to be unique per
    # target org too, or re-running this script for a second workspace
    # collides on the first one's rows.
    org_name = f"dummy-org-{org_id[:8]}"
    repo = OrgRepo(
        id=uuid4_str(),
        org_id=org_id,
        name=repo_name,
        provider="github",
        org_name=org_name,
        default_branch="main",
        language="TypeScript",
        contributors=[{"username": a} for a in AUTHORS],
        idempotency_key=f"dummy:repo:{repo_name}:{org_id}",
        slug=f"{org_name}/{repo_name}",
        is_active=True,
    )
    db.session.add(repo)
    db.session.add(TeamRepos(
        team_id=team_id,
        org_repo_id=repo.id,
        prod_branches=["main"],
        deployment_type=TeamReposDeploymentType.PR_MERGE,
        is_active=True,
    ))
    db.session.flush()

    prs = []
    for i in range(prs_per_repo):
        opened_days_ago = random.randint(2, 60)
        opened_at = days_ago(opened_days_ago, hour=random.randint(8, 17))
        first_commit_to_open = random.randint(600, 3 * 3600)
        first_response_time = random.randint(600, 6 * 3600)
        rework_time = random.randint(0, 4 * 3600)
        merge_time = random.randint(300, 2 * 3600)
        cycle_time = first_response_time + rework_time + merge_time
        merged_at = opened_at + timedelta(seconds=cycle_time)
        additions = random.randint(5, 400)
        deletions = random.randint(0, 200)
        num = idx * 1000 + i + 1

        pr = PullRequest(
            id=uuid4_str(),
            repo_id=repo.id,
            title=f"Dummy PR #{num}: sample change in {repo_name}",
            url=f"https://github.com/{org_name}/{repo_name}/pull/{num}",
            number=str(num),
            author=random.choice(AUTHORS),
            state=PullRequestState.MERGED,
            base_branch="main",
            head_branch=f"feature/dummy-{num}",
            data={"body": f"Dummy PR body #{num} -- no real ticket reference."},
            created_at=opened_at,
            updated_at=merged_at,
            state_changed_at=merged_at,
            first_response_time=first_response_time,
            rework_time=rework_time,
            merge_time=merge_time,
            cycle_time=cycle_time,
            first_commit_to_open=first_commit_to_open,
            merge_to_deploy=0,
            reviewers=[random.choice(AUTHORS)],
            provider="github",
            rework_cycles=random.randint(0, 2),
            meta={
                "code_stats": {
                    "commits": random.randint(1, 8),
                    "additions": additions,
                    "deletions": deletions,
                    "changed_files": random.randint(1, 12),
                    "comments": random.randint(0, 6),
                },
                "user_profile": {"username": random.choice(AUTHORS)},
            },
        )
        db.session.add(pr)
        # CLUSTOX (seed-script-only): flushing per-row sidesteps a
        # SQLAlchemy 2.x insertmanyvalues/sentinel-matching bug that
        # trips over batching many new UUID-PK rows in one flush.
        db.session.flush()
        prs.append(pr)
    return repo, prs


def seed_project(org_id, team_id, key, name, tickets_per_project):
    # CLUSTOX: Incident has a unique constraint on (provider, key), and
    # a ticket's Incident.key is its own Ticket.key verbatim (see
    # seed_incidents below) -- so the project key has to be unique per
    # target org too, same reasoning as seed_repo's org_name, or
    # re-running this script for a second workspace collides with the
    # first one's tickets/incidents.
    key = f"{key}{org_id[:4].upper()}"
    project = OrgProject(
        id=uuid4_str(),
        org_id=org_id,
        key=key,
        name=name,
        provider="jira",
        idempotency_key=f"dummy:project:{key}:{org_id}",
        is_active=True,
    )
    db.session.add(project)
    db.session.add(TeamProjects(team_id=team_id, org_project_id=project.id, is_active=True))
    db.session.flush()

    tickets = []
    for i in range(tickets_per_project):
        created_days_ago = random.randint(10, 90)
        created_at = days_ago(created_days_ago)
        category = random.choices(STATUS_CATEGORIES, weights=[2, 3, 5])[0]
        issue_type = random.choices(ISSUE_TYPES, weights=[4, 4, 2])[0]
        updated_at = created_at + timedelta(days=random.randint(1, min(created_days_ago, 20)))

        ticket = Ticket(
            id=uuid4_str(),
            org_project_id=project.id,
            key=f"{key}-{i + 1}",
            provider="jira",
            status=category,
            status_category=category,
            idempotency_key=f"dummy:ticket:{key}-{i + 1}:{org_id}",
            data={
                "summary": f"Dummy ticket {key}-{i + 1}: sample {issue_type.lower()}",
                "issue_type": issue_type,
                "assignee": random.choice(AUTHORS),
                "reporter": random.choice(AUTHORS),
            },
            created_at=created_at,
            updated_at=updated_at,
        )
        db.session.add(ticket)
        db.session.flush()
        tickets.append(ticket)

        if category != "To Do":
            db.session.add(TicketState(
                id=uuid4_str(), ticket_id=ticket.id, from_status="To Do",
                to_status="In Progress", changed_at=created_at + timedelta(days=1),
                idempotency_key=f"dummy:ticket:{key}-{i + 1}:{org_id}:state:1",
            ))
            db.session.flush()
        if category == "Done":
            db.session.add(TicketState(
                id=uuid4_str(), ticket_id=ticket.id, from_status="In Progress",
                to_status="Done", changed_at=updated_at,
                idempotency_key=f"dummy:ticket:{key}-{i + 1}:{org_id}:state:2",
            ))
            db.session.flush()

    sprint_specs = [
        (f"{key} Sprint 1", "closed", -42, -28, 10, 9),
        (f"{key} Sprint 2", "closed", -28, -14, 12, 11),
        (f"{key} Sprint 3", "active", -14, 0, 14, 6),
        (f"{key} Sprint 4", "future", 0, 14, 0, 0),
    ]
    for name_, state, start_offset, end_offset, planned, completed in sprint_specs:
        db.session.add(Sprint(
            id=uuid4_str(), org_project_id=project.id, provider="jira",
            external_id=name_.replace(" ", "-").lower(), name=name_, state=state,
            start_date=now + timedelta(days=start_offset), end_date=now + timedelta(days=end_offset),
            planned_count=planned, completed_count=completed,
            idempotency_key=f"dummy:sprint:{name_}:{org_id}",
        ))
        db.session.flush()
    return project, tickets


def link_prs_to_tickets(all_prs, all_tickets):
    """
    Cross-repo/cross-project matching, same as this app's real ticket
    matching allows -- a PR isn't required to match a ticket from "its
    own" project (matcher.py scans title/branch/body for a key, with no
    notion of "this repo pairs with this project"). Ticket.created_at is
    pulled to just before the PR's open date for matched pairs, so the
    extended Lead Time breakdown's "ticket created -> first commit"
    phase is a sane positive duration, not an artifact of two
    independently-randomized dates.
    """
    done_tickets = [t for t in all_tickets if t.status_category == "Done"]
    match_count = min(len(all_prs) // 2, len(done_tickets))
    matched_prs = random.sample(all_prs, match_count)
    matched_tickets = random.sample(done_tickets, match_count)

    for pr, ticket in zip(matched_prs, matched_tickets):
        lead_in = timedelta(hours=random.randint(2, 72))
        new_created_at = pr.created_at - lead_in
        if new_created_at < ticket.updated_at - timedelta(days=120):
            new_created_at = ticket.created_at  # keep whatever it already was
        ticket.created_at = min(ticket.created_at, new_created_at)
        db.session.add(PullRequestTicketMapping(pr_id=pr.id, ticket_id=ticket.id))
        db.session.flush()
    return match_count


def seed_incidents(org_id, team_id, project_summaries):
    """
    Directly seeds Incident rows tied to Bug-type tickets (MID-8's
    Jira-issue-as-incident-source), rather than relying on the org
    opting the JIRA_ISSUE source in and waiting for the next sync cycle
    -- so Change Failure Rate / MTTR have real numbers immediately.

    One OrgIncidentService per project -- matches
    JiraIncidentsETLHandler._adapt_org_incident_service exactly
    (key=str(org_project.id)), not one service shared across every
    project. Deactivating one project's TeamProjects link then freezes
    just that project's incidents (already-synced ones stay counted, no
    new ones sync), the same as it would with a real synced pipeline.
    """
    total = 0
    for project, tickets in project_summaries:
        bug_tickets = [t for t in tickets if (t.data or {}).get("issue_type") == "Bug"]
        if not bug_tickets:
            continue

        service = OrgIncidentService(
            id=uuid4_str(),
            org_id=org_id,
            name=f"{project.name} Incidents",
            provider=IncidentProvider.JIRA.value,
            key=str(project.id),
            meta={},
            source_type=IncidentSource.JIRA_ISSUE,
        )
        db.session.add(service)
        db.session.add(TeamIncidentService(team_id=team_id, service_id=service.id))
        db.session.flush()

        for ticket in bug_tickets:
            is_resolved = ticket.status_category == "Done"
            incident = Incident(
                id=uuid4_str(),
                provider=IncidentProvider.JIRA.value,
                key=ticket.key,
                title=(ticket.data or {}).get("summary", ticket.key),
                status=IncidentStatus.RESOLVED.value if is_resolved else IncidentStatus.TRIGGERED.value,
                creation_date=ticket.created_at,
                resolved_date=ticket.updated_at if is_resolved else None,
                assigned_to=(ticket.data or {}).get("assignee"),
                assignees=[(ticket.data or {}).get("assignee")] if (ticket.data or {}).get("assignee") else [],
                url=f"https://dummy.atlassian.net/browse/{ticket.key}",
                meta={"issue_type": "Bug", "status": ticket.status},
                incident_type=IncidentType.JIRA_ISSUE,
            )
            db.session.add(incident)
            db.session.add(IncidentOrgIncidentServiceMap(incident_id=incident.id, service_id=service.id))
            db.session.flush()
            total += 1
    return total


def seed(org_id, team_name, num_repos, num_projects, prs_per_repo, tickets_per_project, dump_path):
    existing = db.session.query(Team).filter(Team.org_id == org_id, Team.name == team_name).one_or_none()
    if existing:
        print(f"Team '{team_name}' already exists ({existing.id}) under org {org_id} -- not re-seeding. "
              f"Delete it (and its repos/projects) first if you want a fresh set.")
        return

    if num_repos > len(REPO_NAMES) or num_projects > len(PROJECT_SPECS):
        raise ValueError(f"Max {len(REPO_NAMES)} repos / {len(PROJECT_SPECS)} projects supported by this script.")

    team = Team(id=uuid4_str(), org_id=org_id, name=team_name, member_ids=[], is_deleted=False)
    db.session.add(team)
    db.session.flush()

    all_prs, all_tickets = [], []
    repo_summaries, project_summaries = [], []

    for idx, repo_name in enumerate(REPO_NAMES[:num_repos]):
        repo, prs = seed_repo(org_id, team.id, repo_name, idx, prs_per_repo)
        all_prs += prs
        repo_summaries.append((repo, prs))

    for key, name in PROJECT_SPECS[:num_projects]:
        project, tickets = seed_project(org_id, team.id, key, name, tickets_per_project)
        all_tickets += tickets
        project_summaries.append((project, tickets))

    db.session.flush()
    match_count = link_prs_to_tickets(all_prs, all_tickets)
    incident_count = seed_incidents(org_id, team.id, project_summaries)

    db.session.commit()

    print(f"Seeded team '{team_name}' ({team.id}) under org {org_id}")
    print(f"  {num_repos} repos x {prs_per_repo} PRs = {len(all_prs)} PRs")
    print(f"  {num_projects} projects x {tickets_per_project} tickets = {len(all_tickets)} tickets")
    print(f"  {match_count} PR<->ticket links, {num_projects * 4} sprints, {incident_count} incidents "
          f"(across {num_projects} per-project incident services)")

    if dump_path:
        dump = {
            "team_id": team.id,
            "repos": [
                {
                    "name": repo.name,
                    "id": repo.id,
                    "prs": [
                        {
                            "title": pr.title, "number": pr.number, "author": pr.author,
                            "created_at": pr.created_at.isoformat(), "merged_at": pr.state_changed_at.isoformat(),
                            "additions": pr.meta["code_stats"]["additions"],
                            "deletions": pr.meta["code_stats"]["deletions"],
                            "cycle_time_seconds": pr.cycle_time,
                        }
                        for pr in prs
                    ],
                }
                for repo, prs in repo_summaries
            ],
            "projects": [
                {
                    "name": project.name, "key": project.key, "id": project.id,
                    "tickets": [
                        {
                            "key": t.key, "issue_type": (t.data or {}).get("issue_type"),
                            "status_category": t.status_category,
                            "created_at": t.created_at.isoformat(), "updated_at": t.updated_at.isoformat(),
                        }
                        for t in tickets
                    ],
                }
                for project, tickets in project_summaries
            ],
        }
        with open(dump_path, "w") as f:
            json.dump(dump, f, indent=2, default=str)
        print(f"Wrote {dump_path} (repo/ticket detail, for building a verification report).")


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--org-id", required=True, help="Org UUID to seed the dummy team under.")
    parser.add_argument("--team-name", default="Dummy (Test Data)")
    parser.add_argument("--repos", type=int, default=3, help=f"Number of dummy repos, up to {len(REPO_NAMES)}.")
    parser.add_argument("--projects", type=int, default=3, help=f"Number of dummy Jira projects, up to {len(PROJECT_SPECS)}.")
    parser.add_argument("--prs-per-repo", type=int, default=25)
    parser.add_argument("--tickets-per-project", type=int, default=20)
    parser.add_argument("--dump-path", default=None, help="Optional path to write a JSON dump of everything seeded.")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    flask_app = make_app()
    with flask_app.app_context():
        seed(
            args.org_id, args.team_name, args.repos, args.projects,
            args.prs_per_repo, args.tickets_per_project, args.dump_path,
        )
