jest.mock('@/auth/session', () => ({ getAuthSession: jest.fn() }));
jest.mock('@/api-helpers/axios', () => ({
  internal: { delete: jest.fn(), patch: jest.fn() }
}));

import { internal } from '@/api-helpers/axios';
import { getAuthSession } from '@/auth/session';

import handler from '../[connection_id]';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTION_ID = '33333333-3333-4333-8333-333333333333';

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
  features: Record<string, unknown> = { show_jira_multi_account: true }
) =>
  ({
    method,
    query: {
      org_id: ORG_ID,
      connection_id: CONNECTION_ID,
      feature_flags: JSON.stringify(features)
    },
    body: {},
    headers: {}
  }) as any;

const asAuthed = () =>
  (getAuthSession as jest.Mock).mockResolvedValue({
    userId: 'u1',
    email: 'admin@clustox.com',
    name: 'Admin',
    role: 'SUPERADMIN'
  });

describe('/api/resources/orgs/[org_id]/jira-connections/[connection_id]', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    asAuthed();
  });

  describe('DELETE', () => {
    it('proxies to the analytics server', async () => {
      (internal.delete as jest.Mock).mockResolvedValue({ data: { ok: true } });
      const res = mockRes();

      await handler(mockReq('DELETE'), res);

      expect(internal.delete).toHaveBeenCalledWith(
        `/orgs/${ORG_ID}/integrations/jira-connections/${CONNECTION_ID}`
      );
      expect(res.send).toHaveBeenCalledWith({ ok: true });
    });

    it('forwards a 409 when the connection is still referenced', async () => {
      (internal.delete as jest.Mock).mockRejectedValue({
        response: {
          status: 409,
          data: { error: 'JiraConnection still has projects synced from it' }
        }
      });
      const res = mockRes();

      await handler(mockReq('DELETE'), res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.send).toHaveBeenCalledWith({
        message: 'JiraConnection still has projects synced from it'
      });
    });

    it('forwards a 404 for an unknown connection', async () => {
      (internal.delete as jest.Mock).mockRejectedValue({
        response: { status: 404, data: { error: 'No JiraConnection' } }
      });
      const res = mockRes();

      await handler(mockReq('DELETE'), res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('is a 404 while the feature flag is off', async () => {
      const res = mockRes();

      await handler(mockReq('DELETE', {}), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(internal.delete).not.toHaveBeenCalled();
    });
  });

  describe('PATCH', () => {
    it('proxies the set-default request to the analytics server', async () => {
      (internal.patch as jest.Mock).mockResolvedValue({ data: { ok: true } });
      const res = mockRes();

      await handler(mockReq('PATCH'), res);

      expect(internal.patch).toHaveBeenCalledWith(
        `/orgs/${ORG_ID}/integrations/jira-connections/${CONNECTION_ID}`
      );
      expect(res.send).toHaveBeenCalledWith({ ok: true });
    });

    it('is a 404 while the feature flag is off', async () => {
      const res = mockRes();

      await handler(mockReq('PATCH', {}), res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(internal.patch).not.toHaveBeenCalled();
    });
  });
});
