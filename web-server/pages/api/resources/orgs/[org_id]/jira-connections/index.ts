// CLUSTOX: BFF routes for Jira multi-account support -- see
// docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 3. GET lists an org's JiraConnection
// rows, POST creates one; both proxy straight through to the analytics
// server (mirrors pages/api/clustox/jenkins/mappings.ts), which owns
// encrypt-on-write and the (org_id, site_url, email) uniqueness check.
// Deliberately additive: orgs/[org_id]/integration.ts's legacy single-Jira
// row is untouched by this file.
import * as yup from 'yup';

import { internal } from '@/api-helpers/axios';
import { Endpoint } from '@/api-helpers/global';
import { forwardInternalError } from '@/api-helpers/internal-error';
import { ResponseError } from '@/constants/error';
import { ApiRequest } from '@/types/request';

const pathSchema = yup.object().shape({
  org_id: yup.string().uuid().required()
});

const postSchema = yup.object().shape({
  org_id: yup.string().uuid().required(),
  site_url: yup.string().required(),
  email: yup.string().email().required(),
  access_token: yup.string().required(),
  provider_meta: yup.object().optional()
});

// CLUSTOX: still landing -- see show_jira_multi_account's own comment in
// constants/feature.ts. A 404 rather than a 403: while the feature is off,
// these routes should read as not existing at all, not as a permission an
// admin might think to ask for.
const assertFeatureEnabled = (req: ApiRequest<any>) => {
  if (!req.meta?.features?.show_jira_multi_account) {
    throw new ResponseError('Not found', 404);
  }
};

const endpoint = new Endpoint(pathSchema);

endpoint.handle.GET(pathSchema, async (req, res) => {
  assertFeatureEnabled(req);

  const result = await internal
    .get(`/orgs/${req.payload.org_id}/integrations/jira-connections`)
    .catch(forwardInternalError);
  res.send(result.data);
});

endpoint.handle.POST(postSchema, async (req, res) => {
  assertFeatureEnabled(req);

  const { org_id, site_url, email, access_token, provider_meta } = req.payload;

  const result = await internal
    .post(`/orgs/${org_id}/integrations/jira-connections`, {
      site_url,
      email,
      access_token,
      provider_meta,
      // The analytics server records who linked a connection; only this BFF
      // layer knows who is actually signed in.
      generated_by: req.session?.userId ?? null
    })
    .catch(forwardInternalError);
  res.status(201).send(result.data);
});

export default endpoint.serve();
