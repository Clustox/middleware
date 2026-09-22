jest.mock('@/auth/session', () => ({ getAuthSession: jest.fn() }));
jest.mock('@/api-helpers/axios', () => ({
  internal: { get: jest.fn(), post: jest.fn() }
}));

import { internal } from '@/api-helpers/axios';
import { getAuthSession } from '@/auth/session';

import handler from '../index';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.send = jest.fn(() => res);
  return res;
};

// CLUSTOX: feature flags reach the handler via req.query.feature_flags (see
// getFlagsFromRequest), not a `meta` field set directly on the request --
// transformNextRequest recomputes `meta` from that query param and would
// overwrite anything set here.
const mockReq = (
  method: string,
  body: Record<string, unknown> = {},
  features: Record<string, unknown> | null = { show_jira_multi_account: true }
) =>
  ({
    method,
    query: {
      org_id: ORG_ID,
      ...(features ? { feature_flags: JSON.stringify(features) } : {})
    },
    body,
    headers: {}
  }) as any;

const asAuthed = () =>
  (getAuthSession as jest.Mock).mockResolvedValue({
    userId: 'u1',
    email: 'admin@clustox.com',
    name: 'Admin',
    role: 'SUPERADMIN'
  });

describe('/api/resources/orgs/[org_id]/jira-connections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    asAuthed();
  });

  describe('GET', () => {
    it('lists the connections the analytics server returns', async () => {
      (internal.get as jest.Mock).mockResolvedValue({
        data: [{ id: 'c1', site_url: 'acme.atlassian.net', is_default: true }]
      });
      const res = mockRes();

      await handler(mockReq('GET'), res);

      expect(internal.get).toHaveBeenCalledWith(
        `/orgs/${ORG_ID}/integrations/jira-connections`
      );
      expect(res.send).toHaveBeenCalledWith([
        { id: 'c1', site_url: 'acme.atlassian.net', is_default: true }
      ]);
    });

    it('is a 404 while the feature flag is off', async () => {
      const res = mockRes();

      await handler(mockReq('GET', {}, {}), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(internal.get).not.toHaveBeenCalled();
    });
  });

  describe('POST', () => {
    const body = {
      site_url: 'acme.atlassian.net',
      email: 'a@acme.com',
      access_token: 'raw-token'
    };

    it('creates a connection and stamps the signed-in user as generated_by', async () => {
      (internal.post as jest.Mock).mockResolvedValue({
        data: { id: 'c1', site_url: 'acme.atlassian.net', is_default: false }
      });
      const res = mockRes();

      await handler(mockReq('POST', body), res);

      expect(internal.post).toHaveBeenCalledWith(
        `/orgs/${ORG_ID}/integrations/jira-connections`,
        {
          site_url: 'acme.atlassian.net',
          email: 'a@acme.com',
          access_token: 'raw-token',
          provider_meta: undefined,
          generated_by: 'u1'
        }
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.send).toHaveBeenCalledWith({
        id: 'c1',
        site_url: 'acme.atlassian.net',
        is_default: false
      });
    });

    it('forwards the analytics server 409 for a duplicate account, with its message', async () => {
      (internal.post as jest.Mock).mockRejectedValue({
        response: {
          status: 409,
          data: { error: 'a@acme.com is already connected to acme.atlassian.net' }
        }
      });
      const res = mockRes();

      await handler(mockReq('POST', body), res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.send).toHaveBeenCalledWith({
        message: 'a@acme.com is already connected to acme.atlassian.net'
      });
    });

    it('rejects a body missing the required access_token', async () => {
      const res = mockRes();

      await handler(
        mockReq('POST', { site_url: 'acme.atlassian.net', email: 'a@acme.com' }),
        res
      );

      expect(internal.post).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('is a 404 while the feature flag is off', async () => {
      const res = mockRes();

      await handler(mockReq('POST', body, {}), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(internal.post).not.toHaveBeenCalled();
    });
  });
});
