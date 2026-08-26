import * as yup from 'yup';

import { getBitbucketCredentials } from '@/api/internal/[org_id]/utils';
import { handleRequest } from '@/api-helpers/axios';
import { Endpoint } from '@/api-helpers/global';
import { CIProvider, Integration } from '@/constants/integrations';
import { RepoWorkflowResponse, RepoWorkflow } from '@/types/resources';

const pathSchema = yup.object().shape({
  org_id: yup.string().uuid().required()
});

const getSchema = yup.object().shape({
  provider: yup.string().oneOf(Object.values(Integration)),
  org_name: yup.string().required(),
  repo_name: yup.string().required(),
  repo_slug: yup.string().required()
});

const endpoint = new Endpoint(pathSchema);

endpoint.handle.GET(getSchema, async (req, res) => {
  const { org_id, provider, org_name, repo_name, repo_slug, next_page_token } =
    req.payload;

  // CLUSTOX: a Bitbucket repo has exactly one pipeline system, so the
  // picker gets exactly one synthetic entry -- but only when the repo
  // actually has pipelines enabled. Offering it unconditionally would let a
  // user select a "workflow" that never produces a run, silently: mapped,
  // synced, zero deployments, no error anywhere. One pagelen=1 probe answers
  // "are there any runs at all".
  if (provider === Integration.BITBUCKET) {
    try {
      const { email, token } = await getBitbucketCredentials(org_id);
      const probe = await fetch(
        `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(
          org_name
        )}/${encodeURIComponent(repo_slug)}/pipelines/?pagelen=1`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString(
              'base64'
            )}`
          }
        }
      );
      const hasPipelines = probe.ok && ((await probe.json()).size ?? 0) > 0;
      return res.send({
        workflows: hasPipelines
          ? [
              {
                id: `${org_name}/${repo_slug}`,
                name: 'Bitbucket Pipelines',
                html_url: `https://bitbucket.org/${org_name}/${repo_slug}/pipelines`,
                ci_provider: CIProvider.BITBUCKET_PIPELINES,
                // CLUSTOX: this value becomes RepoWorkflow.provider_workflow_id,
                // which the sync handler partitions back into workspace/slug --
                // the exact contract the backend test pins.
                provider_workflow_id: `${org_name}/${repo_slug}`
              }
            ]
          : [],
        next_page_token: null
      });
    } catch (e) {
      // No secrets in this error path; degrade to an empty picker rather
      // than surfacing a raw failure into the team-edit UI.
      return res.send({ workflows: [], next_page_token: null });
    }
  }

  const githubActionWorkflowsPromise =
    provider === Integration.GITHUB
      ? handleRequest<RepoWorkflow[]>(
          `/orgs/${org_id}/integrations/${provider}/${org_name}/${repo_name}/workflows`
        ).then((workflows) =>
          adaptWorkflows(workflows, CIProvider.GITHUB_ACTIONS)
        )
      : Promise.resolve([]);

  let params: { repo_slug: string; page_token?: string } = {
    repo_slug: repo_slug
  };

  if (next_page_token || next_page_token === null)
    params['page_token'] = next_page_token;

  const [githubActionWorkflows, circleciWorkflows] = await Promise.all([
    githubActionWorkflowsPromise,
    handleRequest<RepoWorkflowResponse>(
      `/orgs/${org_id}/integrations/circleci/${provider}/${org_name}/${repo_name}/workflows`,
      { params }
    )
      .then((workflows) => ({
        workflows: adaptWorkflows(workflows.workflows, CIProvider.CIRCLE_CI),
        next_page_token: workflows.next_page_token
      }))
      .catch(() => ({ workflows: [], next_page_token: null }))
  ]);
  return res.send({
    workflows: [...githubActionWorkflows, ...circleciWorkflows.workflows],
    next_page_token: circleciWorkflows.next_page_token
  });
});

const adaptWorkflows = (
  repoWorkflows: RepoWorkflow[],
  ciProvider: CIProvider
) => {
  return repoWorkflows.map((workflows) => ({
    ...workflows,
    ci_provider: ciProvider
  }));
};

export default endpoint.serve();
