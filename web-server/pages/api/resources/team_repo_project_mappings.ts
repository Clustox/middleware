import * as yup from 'yup';

import { handleRequest } from '@/api-helpers/axios';
import { Endpoint, nullSchema } from '@/api-helpers/global';

// CLUSTOX: explicit, informational repo<->Jira-project pairing within a
// team -- see docs/JIRA_MULTI_ACCOUNT_PLAN.md's follow-up on Jira<->repo
// relationships. Mirrors team_projects.ts's shape exactly ("GET the
// current set / PUT the full replacement set"); deliberately its own
// standalone resource for the same reason that one is separate from the
// repo-selection save flow. Never read by PR<->ticket matching -- see
// TeamRepoProjectMapping's own docstring on the backend.
export type TeamRepoProjectMapping = {
  org_repo_id: string;
  org_project_id: string;
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
        org_project_id: yup.string().uuid().required()
      })
    )
    .required()
});

const endpoint = new Endpoint(nullSchema);

endpoint.handle.GET(getSchema, async (req, res) => {
  res.send(
    await handleRequest<TeamRepoProjectMapping[]>(
      `/teams/${req.payload.team_id}/repo_project_mappings`
    )
  );
});

endpoint.handle.PUT(putSchema, async (req, res) => {
  const { team_id, mappings } = req.payload;

  const updated = await handleRequest<TeamRepoProjectMapping[]>(
    `/teams/${team_id}/repo_project_mappings`,
    {
      method: 'PUT',
      data: { mappings }
    }
  );

  res.send(updated);
});

export default endpoint.serve();
