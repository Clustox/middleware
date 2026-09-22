import { useCallback, useEffect, useState } from 'react';

import { handleApi } from '@/api-helpers/axios-api-instance';

export type JiraConnection = {
  id: string;
  site_url: string;
  email: string;
  is_default: boolean;
  provider_meta: Record<string, unknown>;
  created_at: string | null;
};

export type NewJiraConnection = {
  site_url: string;
  email: string;
  access_token: string;
};

// CLUSTOX: no manual feature_flags stamping here -- middleware.ts already
// appends one `feature_flags` query param to every request (page and API
// alike), built from the resolved flags (defaults + cookie overrides). A
// second, hand-added `feature_flags` param used to collide with it: two
// query params of the same name parse as an array, and JSON.parse coerces
// that array to a comma-joined string, corrupting the JSON right at the
// join -- the "Unexpected non-whitespace character..." bug this comment
// replaces. See docs/JIRA_MULTI_ACCOUNT_PLAN.md Task 6.
const basePath = (orgId: string) => `/resources/orgs/${orgId}/jira-connections`;

export const useJiraConnections = (orgId: string | null) => {
  const [connections, setConnections] = useState<JiraConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setFailed(false);
    try {
      const data = await handleApi<JiraConnection[]>(basePath(orgId));
      setConnections(data || []);
    } catch (e) {
      console.error('Failed to load Jira connections', e);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const create = useCallback(
    async (payload: NewJiraConnection) => {
      if (!orgId) throw new Error('No workspace selected');
      await handleApi(basePath(orgId), {
        method: 'post',
        data: payload
      });
      await load();
    },
    [orgId, load]
  );

  const remove = useCallback(
    async (connectionId: string) => {
      if (!orgId) throw new Error('No workspace selected');
      await handleApi(`${basePath(orgId)}/${connectionId}`, {
        method: 'delete'
      });
      await load();
    },
    [orgId, load]
  );

  const setDefault = useCallback(
    async (connectionId: string) => {
      if (!orgId) throw new Error('No workspace selected');
      await handleApi(`${basePath(orgId)}/${connectionId}`, {
        method: 'patch'
      });
      await load();
    },
    [orgId, load]
  );

  return {
    connections,
    loading,
    failed,
    reload: load,
    create,
    remove,
    setDefault
  };
};
