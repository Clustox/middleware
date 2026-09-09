import axios from 'axios';
import * as yup from 'yup';

import { Endpoint } from '@/api-helpers/global';
import { Integration } from '@/constants/integrations';
import { dec } from '@/utils/auth-supplementary';
import { db } from '@/utils/db';

const pathSchema = yup.object().shape({
  org_id: yup.string().uuid().required()
});

const getSchema = yup.object().shape({
  search_text: yup.string().optional().nullable(),
  // CLUSTOX: Jira multi-account support -- see
  // docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 6 part 2. Omitted entirely means
  // "search the legacy single-account Integration row", unchanged from
  // before this existed.
  connection_id: yup.string().uuid().optional().nullable()
});

export type JiraProjectSearchResult = {
  id: string;
  key: string;
  name: string;
  idempotency_key: string;
  provider: Integration.JIRA;
  // CLUSTOX: threaded back through team_projects.ts's PUT so
  // ProjectService can record which JiraConnection this project came
  // from. Absent for a legacy-flow result, same reasoning as above.
  connection_id?: string;
};

const endpoint = new Endpoint(pathSchema);

// CLUSTOX: Jira integration, Phase 2 (project selection) -- live project
// search for the team-creation picker. Unlike the GitHub/GitLab repo
// search this mirrors (searchGithubRepos/gitlabSearch in
// pages/api/internal/[org_id]/utils.ts), there's no pre-synced OrgProject
// catalog to search yet in this phase -- Jira's own /project/search
// endpoint already supports server-side name/key filtering, so querying
// it directly here is simpler than standing up a sync job just to make
// this box searchable. See docs/JIRA_INTEGRATION_PROPOSAL.md.
endpoint.handle.GET(getSchema, async (req, res) => {
  const { org_id, search_text, connection_id } = req.payload;

  const credentials = connection_id
    ? await getJiraConnectionCredentials(org_id, connection_id)
    : await getLegacyJiraCredentials(org_id);

  if (!credentials) {
    return res.status(404).send({
      error: connection_id
        ? 'That Jira connection was not found for this workspace'
        : 'Jira is not linked for this workspace'
    });
  }
  const { siteUrl, email, apiToken } = credentials;

  // CLUSTOX: search-as-you-type on the client aborts a superseded request
  // (see useTeamJiraProjectsConfig's controllerRef), but that only tears
  // down the browser's connection to *this* route -- without this, the
  // outbound call to Jira below keeps running to completion (or its own
  // 8s timeout) regardless, so a burst of keystrokes piles up that many
  // uncancelled real Jira requests concurrently. `res` (unlike `req`,
  // which Endpoint.serve() passes to handlers as a shallow-spread plain
  // object -- see transformNextRequest -- and so has lost its
  // EventEmitter prototype methods) is the real, untouched
  // http.ServerResponse, whose 'close' event fires exactly when the
  // client disconnects, so forwarding it into an AbortController here
  // lets the Jira call stop too instead of running to completion for
  // nothing.
  const outboundAbort = new AbortController();
  res.on('close', () => outboundAbort.abort());

  try {
    const response = await axios.get(
      `https://${siteUrl}/rest/api/3/project/search`,
      {
        auth: { username: email, password: apiToken },
        params: {
          maxResults: 50,
          ...(search_text ? { query: search_text } : {})
        },
        signal: outboundAbort.signal,
        timeout: 8000
      }
    );

    const projects: JiraProjectSearchResult[] = (
      response.data?.values || []
    ).map((project: { id: string; key: string; name: string }) => ({
      id: String(project.id),
      key: project.key,
      name: project.name,
      // Scoped by org_id, not the bare Jira id -- two different orgs'
      // independent Jira sites can otherwise land on the same small,
      // site-local project id. Further scoped by connection_id when one
      // was given: two connections in the same org are two independent
      // Jira sites too, and a bare org_id scope would collide their
      // site-local project ids exactly the way ticket idempotency keys
      // could (see docs/JIRA_MULTI_ACCOUNT_PLAN.md, "Known risks" #1). The
      // legacy (no connection_id) branch keeps the original key shape --
      // changing it would orphan every project already selected through
      // the single-account flow.
      idempotency_key: connection_id
        ? `jira:${org_id}:${connection_id}:${project.id}`
        : `jira:${org_id}:${project.id}`,
      provider: Integration.JIRA,
      ...(connection_id ? { connection_id } : {})
    }));

    return res.status(200).send(projects);
  } catch (error: any) {
    // Surfaced as a plain failure rather than a 500 -- an expired/revoked
    // Jira token, or Jira itself being briefly unreachable, isn't our own
    // server breaking.
    const status = error?.response?.status;
    return res.status(status === 401 || status === 403 ? 401 : 502).send({
      error: 'Could not reach Jira to search projects.'
    });
  }
});

export default endpoint.serve();

type JiraCredentials = { siteUrl: string; email: string; apiToken: string };

const getLegacyJiraCredentials = async (
  org_id: string
): Promise<JiraCredentials | null> => {
  const integration = await db('Integration')
    .select('provider_meta', 'access_token_enc_chunks')
    .where({ org_id, name: Integration.JIRA })
    .first();

  const siteUrl = integration?.provider_meta?.site_url;
  const email = integration?.provider_meta?.email;
  const apiToken = integration?.access_token_enc_chunks
    ? dec(integration.access_token_enc_chunks)
    : null;

  return siteUrl && email && apiToken ? { siteUrl, email, apiToken } : null;
};

const getJiraConnectionCredentials = async (
  org_id: string,
  connection_id: string
): Promise<JiraCredentials | null> => {
  // CLUSTOX: org_id in the where-clause, not just the connection's own id
  // -- a connection_id alone must never resolve across orgs, same
  // reasoning as JiraConnectionRepoService.get_jira_connection on the
  // Python side.
  const connection = await db('JiraConnection')
    .select('site_url', 'email', 'access_token_enc_chunks')
    .where({ org_id, id: connection_id })
    .first();

  if (!connection?.site_url || !connection?.email) return null;

  const apiToken = connection.access_token_enc_chunks
    ? dec(connection.access_token_enc_chunks)
    : null;

  return apiToken
    ? { siteUrl: connection.site_url, email: connection.email, apiToken }
    : null;
};
