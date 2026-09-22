// CLUSTOX: BFF routes for a single JiraConnection -- see
// docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 3. DELETE removes it (blocked
// server-side while an OrgProjectConnection still references it), PATCH
// marks it the org's default. Both proxy through to the analytics server,
// which owns those invariants -- see index.ts's header for why this isn't a
// direct knex write.
import * as yup from 'yup';

import { internal } from '@/api-helpers/axios';
import { Endpoint } from '@/api-helpers/global';
import { forwardInternalError } from '@/api-helpers/internal-error';
import { ResponseError } from '@/constants/error';
import { ApiRequest } from '@/types/request';

const pathSchema = yup.object().shape({
  org_id: yup.string().uuid().required(),
  connection_id: yup.string().uuid().required()
});

// See index.ts's assertFeatureEnabled for why this is a 404, not a 403.
const assertFeatureEnabled = (req: ApiRequest<any>) => {
  if (!req.meta?.features?.show_jira_multi_account) {
    throw new ResponseError('Not found', 404);
  }
};

const endpoint = new Endpoint(pathSchema);

endpoint.handle.DELETE(pathSchema, async (req, res) => {
  assertFeatureEnabled(req);

  const { org_id, connection_id } = req.payload;

  const result = await internal
    .delete(`/orgs/${org_id}/integrations/jira-connections/${connection_id}`)
    .catch(forwardInternalError);
  res.send(result.data);
});

endpoint.handle.PATCH(pathSchema, async (req, res) => {
  assertFeatureEnabled(req);

  const { org_id, connection_id } = req.payload;

  const result = await internal
    .patch(`/orgs/${org_id}/integrations/jira-connections/${connection_id}`)
    .catch(forwardInternalError);
  res.send(result.data);
});

export default endpoint.serve();
