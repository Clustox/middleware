import * as yup from 'yup';

import { handleRequest } from '@/api-helpers/axios';
import { Endpoint, nullSchema } from '@/api-helpers/global';

// CLUSTOX: which single Jira project (if any) each of a team's repos
// maps to -- see docs/JIRA_INTEGRATION_PROPOSAL.md, "Repo <-> Project
// Mapping". Mirrors team_projects.ts's shape (thin proxy to the Python
// backend, GET the current set / PUT the full replacement set) --
// deliberately its own standalone resource rather than folded into
// either team_repos.ts or team_projects.ts, since this is a genuinely
// different relationship (repo <-> project, not team <-> repo/project).
export type RepoProjectMappingEntry = {
  org_repo_id: string;
  repo_name: string;
  org_project_id: string | null;
};

const getSchema = yup.object().shape({
  team_id: yup.string().uuid().required()
});

const putSchema = yup.object().shape({
  team_id: yup.string().uuid().required(),
  mappings: yup
    .array()
    .of(
      yup.object().shape({
        org_repo_id: yup.string().uuid().required(),
        // null unmaps the repo -- distinct from omitting the entry
        // entirely, which leaves that repo's existing mapping untouched.
        org_project_id: yup.string().uuid().nullable().defined()
      })
    )
    .required()
});

const endpoint = new Endpoint(nullSchema);

endpoint.handle.GET(getSchema, async (req, res) => {
  res.send(await getTeamRepoProjectMapping(req.payload.team_id));
});

export const getTeamRepoProjectMapping = (team_id: ID) =>
  handleRequest<RepoProjectMappingEntry[]>(
    `/teams/${team_id}/repo_project_mapping`
  );

endpoint.handle.PUT(putSchema, async (req, res) => {
  const { team_id, mappings } = req.payload;

  const updated = await handleRequest<RepoProjectMappingEntry[]>(
    `/teams/${team_id}/repo_project_mapping`,
    {
      method: 'PUT',
      data: { mappings }
    }
  );

  res.send(updated);
});

export default endpoint.serve();
