jest.mock('axios');

import { renderHook, waitFor } from '@testing-library/react';
import axios from 'axios';

import { useTeamRepoProjectMappings } from '../useTeamRepoProjectMappings';

const TEAM_ID = 'team-1';

// CLUSTOX: regression coverage for a real bug -- /api/resources/team_projects
// (adapt_org_project on the backend) returns the OrgProject id as "id", not
// "org_project_id". Reading the wrong field left every project sharing the
// same (undefined) org_project_id, which made MUI's Autocomplete treat every
// project as equal to every other one: selecting one project in the UI would
// display a *different* one, and re-selecting it would clear the pairing
// entirely. TeamRepoProjectMappings.test.tsx can't catch this -- it mocks
// this hook outright, so the field-mapping bug lived entirely here.
describe('useTeamRepoProjectMappings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (axios as unknown as jest.Mock).mockImplementation((url: string) => {
      if (url === '/api/resources/team_repos') {
        return Promise.resolve({ data: [{ id: 'repo-1', name: 'middleware' }] });
      }
      if (url === '/api/resources/team_projects') {
        return Promise.resolve({
          data: [
            { id: 'org-project-mid', key: 'MID', name: 'middleware' },
            { id: 'org-project-tes', key: 'TES', name: 'testproject' }
          ]
        });
      }
      if (url === '/api/resources/team_repo_project_mappings') {
        return Promise.resolve({ data: [] });
      }
      return Promise.reject(new Error(`unexpected request: ${url}`));
    });
  });

  it('gives each project its own org_project_id, derived from the API\'s "id" field', async () => {
    const { result } = renderHook(() => useTeamRepoProjectMappings(TEAM_ID));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.projects).toEqual([
      { org_project_id: 'org-project-mid', key: 'MID', name: 'middleware' },
      { org_project_id: 'org-project-tes', key: 'TES', name: 'testproject' }
    ]);
    // The bug this guards against: both used to end up undefined, i.e. equal.
    const [mid, tes] = result.current.projects;
    expect(mid.org_project_id).not.toBe(tes.org_project_id);
    expect(mid.org_project_id).not.toBeUndefined();
    expect(tes.org_project_id).not.toBeUndefined();
  });
});
