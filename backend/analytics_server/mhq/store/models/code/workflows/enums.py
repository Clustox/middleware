from enum import Enum


class RepoWorkflowProviders(Enum):
    GITHUB_ACTIONS = "github"
    CIRCLE_CI = "circle_ci"
    # CLUSTOX: Jenkins as a deployment source. Persisted as varchar, so no
    # migration is required despite the ENUM() wrapper on the column.
    JENKINS = "jenkins"
    # CLUSTOX: value "bitbucket", mirroring GITHUB_ACTIONS = "github" -- the
    # BFF team-save writes the repo's Integration value into
    # RepoWorkflow.provider, and the sync loop reconstructs the enum from that
    # string. A fancier value would orphan every row the UI writes.
    BITBUCKET_PIPELINES = "bitbucket"

    @classmethod
    def get_workflow_providers(cls):
        return [v for v in cls.__members__.values()]

    @classmethod
    def get_workflow_providers_values(cls):
        return [v.value for v in cls.__members__.values()]

    @classmethod
    def get_enum(cls, provider: str):
        for v in cls.__members__.values():
            if provider == v.value:
                return v
        return None


class RepoWorkflowType(Enum):
    DEPLOYMENT = "DEPLOYMENT"


class RepoWorkflowRunsStatus(Enum):
    SUCCESS = "SUCCESS"
    FAILURE = "FAILURE"
    PENDING = "PENDING"
    CANCELLED = "CANCELLED"
