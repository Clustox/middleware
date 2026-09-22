jest.mock('@/auth/session', () => ({ getAuthSession: jest.fn() }));
jest.mock('@/api-helpers/axios', () => ({ handleRequest: jest.fn() }));

import { handleRequest } from '@/api-helpers/axios';
import { getAuthSession } from '@/auth/session';

import mappingsHandler from '../team_repo_project_mappings';

const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const REPO_ID = '33333333-3333-4333-8333-333333333333';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.send = jest.fn(() => res);
  return res;
};

const mockReq = (
  method: string,
  query: Record<string, unknown>,
  body: Record<string, unknown> = {}
) => ({ method, query, body, headers: {} }) as any;

const asAuthed = () =>
  (getAuthSession as jest.Mock).mockResolvedValue({
    userId: 'u1',
    email: 'admin@clustox.com',
    name: 'Admin',
    role: 'SUPERADMIN'
  });

// CLUSTOX: explicit, informational repo<->Jira-project pairing -- a thin
// proxy to the Python backend's /teams/<team_id>/repo_project_mappings,
// same "GET the current set / PUT the full replacement set" shape as
// team_projects.ts. See docs/JIRA_MULTI_ACCOUNT_PLAN.md's follow-up on
// Jira<->repo relationships.
describe('/api/resources/team_repo_project_mappings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    asAuthed();
  });

  describe('GET', () => {
    it('fetches the current mappings for the team', async () => {
      (handleRequest as jest.Mock).mockResolvedValue([
        { org_repo_id: REPO_ID, org_project_id: PROJECT_ID }
      ]);
      const res = mockRes();

      await mappingsHandler(mockReq('GET', { team_id: TEAM_ID }), res);

      expect(handleRequest).toHaveBeenCalledWith(
        `/teams/${TEAM_ID}/repo_project_mappings`
      );
      expect(res.send).toHaveBeenCalledWith([
        { org_repo_id: REPO_ID, org_project_id: PROJECT_ID }
      ]);
    });
  });

  describe('PUT', () => {
    it('forwards the full replacement mapping set to the backend', async () => {
      (handleRequest as jest.Mock).mockResolvedValue([
        { org_repo_id: REPO_ID, org_project_id: PROJECT_ID }
      ]);
      const res = mockRes();

      await mappingsHandler(
        mockReq(
          'PUT',
          { team_id: TEAM_ID },
          { mappings: [{ org_repo_id: REPO_ID, org_project_id: PROJECT_ID }] }
        ),
        res
      );

      expect(handleRequest).toHaveBeenCalledWith(
        `/teams/${TEAM_ID}/repo_project_mappings`,
        {
          method: 'PUT',
          data: {
            mappings: [{ org_repo_id: REPO_ID, org_project_id: PROJECT_ID }]
          }
        }
      );
      expect(res.send).toHaveBeenCalledWith([
        { org_repo_id: REPO_ID, org_project_id: PROJECT_ID }
      ]);
    });

    it('accepts an empty mappings array (clearing every pairing)', async () => {
      (handleRequest as jest.Mock).mockResolvedValue([]);
      const res = mockRes();

      await mappingsHandler(
        mockReq('PUT', { team_id: TEAM_ID }, { mappings: [] }),
        res
      );

      expect(handleRequest).toHaveBeenCalledWith(
        `/teams/${TEAM_ID}/repo_project_mappings`,
        { method: 'PUT', data: { mappings: [] } }
      );
    });

    it('rejects a body missing the required mappings array', async () => {
      const res = mockRes();

      await mappingsHandler(mockReq('PUT', { team_id: TEAM_ID }, {}), res);

      expect(handleRequest).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});
