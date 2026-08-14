jest.mock('@/auth/session', () => ({ getAuthSession: jest.fn() }));
jest.mock('@/api-helpers/axios', () => ({ handleRequest: jest.fn() }));

import { handleRequest } from '@/api-helpers/axios';
import { getAuthSession } from '@/auth/session';

import mappingHandler from '../team_repo_project_mapping';

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

// CLUSTOX: Repo <-> Project Mapping (docs/JIRA_INTEGRATION_PROPOSAL.md).
// This route is a thin proxy to the Python backend's
// /teams/<team_id>/repo_project_mapping -- mirrors team_projects.ts,
// which this file's GET/PUT handlers are modeled on.
describe('/api/resources/team_repo_project_mapping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    asAuthed();
  });

  describe('GET', () => {
    it('fetches the current mapping for the team', async () => {
      (handleRequest as jest.Mock).mockResolvedValue([
        { org_repo_id: REPO_ID, repo_name: 'payments-api', org_project_id: null }
      ]);
      const res = mockRes();

      await mappingHandler(mockReq('GET', { team_id: TEAM_ID }), res);

      expect(handleRequest).toHaveBeenCalledWith(
        `/teams/${TEAM_ID}/repo_project_mapping`
      );
      expect(res.send).toHaveBeenCalledWith([
        { org_repo_id: REPO_ID, repo_name: 'payments-api', org_project_id: null }
      ]);
    });
  });

  describe('PUT', () => {
    it('forwards the mapping entries to the backend as-is', async () => {
      (handleRequest as jest.Mock).mockResolvedValue([
        {
          org_repo_id: REPO_ID,
          repo_name: 'payments-api',
          org_project_id: PROJECT_ID
        }
      ]);
      const res = mockRes();

      await mappingHandler(
        mockReq(
          'PUT',
          { team_id: TEAM_ID },
          {
            mappings: [
              { org_repo_id: REPO_ID, org_project_id: PROJECT_ID }
            ]
          }
        ),
        res
      );

      expect(handleRequest).toHaveBeenCalledWith(
        `/teams/${TEAM_ID}/repo_project_mapping`,
        {
          method: 'PUT',
          data: {
            mappings: [{ org_repo_id: REPO_ID, org_project_id: PROJECT_ID }]
          }
        }
      );
      expect(res.send).toHaveBeenCalledWith([
        {
          org_repo_id: REPO_ID,
          repo_name: 'payments-api',
          org_project_id: PROJECT_ID
        }
      ]);
    });

    it('accepts a null org_project_id to unmap a repo', async () => {
      (handleRequest as jest.Mock).mockResolvedValue([
        { org_repo_id: REPO_ID, repo_name: 'payments-api', org_project_id: null }
      ]);
      const res = mockRes();

      await mappingHandler(
        mockReq(
          'PUT',
          { team_id: TEAM_ID },
          { mappings: [{ org_repo_id: REPO_ID, org_project_id: null }] }
        ),
        res
      );

      expect(handleRequest).toHaveBeenCalledWith(
        `/teams/${TEAM_ID}/repo_project_mapping`,
        {
          method: 'PUT',
          data: { mappings: [{ org_repo_id: REPO_ID, org_project_id: null }] }
        }
      );
    });

    it('rejects an empty body missing the required mappings array', async () => {
      const res = mockRes();

      await mappingHandler(mockReq('PUT', { team_id: TEAM_ID }, {}), res);

      expect(handleRequest).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects an entry with a non-uuid org_repo_id', async () => {
      const res = mockRes();

      await mappingHandler(
        mockReq(
          'PUT',
          { team_id: TEAM_ID },
          { mappings: [{ org_repo_id: 'not-a-uuid', org_project_id: PROJECT_ID }] }
        ),
        res
      );

      expect(handleRequest).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});
