jest.mock('notistack', () => ({ useSnackbar: jest.fn() }));
jest.mock('../useTeamRepoProjectMappings', () => ({
  useTeamRepoProjectMappings: jest.fn()
}));

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSnackbar } from 'notistack';

import { renderWithTheme as render } from '@/utils/testUtils';

import { TeamRepoProjectMappings } from '../TeamRepoProjectMappings';
import { useTeamRepoProjectMappings } from '../useTeamRepoProjectMappings';

const TEAM_ID = 'team-1';

const baseConfig = {
  repos: [{ id: 'repo-1', name: 'frontend' }],
  projects: [{ org_project_id: 'proj-1', key: 'ECOM', name: 'Ecommerce' }],
  mappingsByRepo: {} as Record<string, string[]>,
  setProjectsForRepo: jest.fn(),
  save: jest.fn().mockResolvedValue(true),
  isLoading: false,
  isSaving: false
};

// CLUSTOX: explicit, informational repo<->Jira-project pairing. See
// docs/JIRA_MULTI_ACCOUNT_PLAN.md's follow-up on Jira<->repo
// relationships.
describe('TeamRepoProjectMappings', () => {
  const enqueueSnackbar = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (useSnackbar as jest.Mock).mockReturnValue({ enqueueSnackbar });
    (useTeamRepoProjectMappings as jest.Mock).mockReturnValue(baseConfig);
  });

  it('renders nothing when the team has no repos yet', () => {
    (useTeamRepoProjectMappings as jest.Mock).mockReturnValue({
      ...baseConfig,
      repos: []
    });
    const { container } = render(<TeamRepoProjectMappings teamId={TEAM_ID} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the team has no projects yet', () => {
    (useTeamRepoProjectMappings as jest.Mock).mockReturnValue({
      ...baseConfig,
      projects: []
    });
    const { container } = render(<TeamRepoProjectMappings teamId={TEAM_ID} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows a loading state while fetching', () => {
    (useTeamRepoProjectMappings as jest.Mock).mockReturnValue({
      ...baseConfig,
      isLoading: true
    });
    render(<TeamRepoProjectMappings teamId={TEAM_ID} />);

    expect(
      screen.getByText('Loading repo/project pairings...')
    ).toBeInTheDocument();
  });

  it('lists every repo the team tracks', () => {
    render(<TeamRepoProjectMappings teamId={TEAM_ID} />);

    expect(screen.getByText('frontend')).toBeInTheDocument();
  });

  it('shows the currently paired project as a chip', () => {
    (useTeamRepoProjectMappings as jest.Mock).mockReturnValue({
      ...baseConfig,
      mappingsByRepo: { 'repo-1': ['proj-1'] }
    });
    render(<TeamRepoProjectMappings teamId={TEAM_ID} />);

    expect(screen.getByText('ECOM')).toBeInTheDocument();
  });

  it('calls save and shows a success toast when the button is clicked', async () => {
    const save = jest.fn().mockResolvedValue(true);
    (useTeamRepoProjectMappings as jest.Mock).mockReturnValue({
      ...baseConfig,
      save
    });
    render(<TeamRepoProjectMappings teamId={TEAM_ID} />);

    await userEvent.click(screen.getByRole('button', { name: 'Save pairings' }));

    expect(save).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith(
        'Repo/project pairings updated',
        expect.objectContaining({ variant: 'success' })
      )
    );
  });

  it('shows an error toast when save fails', async () => {
    const save = jest.fn().mockResolvedValue(false);
    (useTeamRepoProjectMappings as jest.Mock).mockReturnValue({
      ...baseConfig,
      save
    });
    render(<TeamRepoProjectMappings teamId={TEAM_ID} />);

    await userEvent.click(screen.getByRole('button', { name: 'Save pairings' }));

    await waitFor(() =>
      expect(enqueueSnackbar).toHaveBeenCalledWith(
        'Failed to update pairings',
        expect.objectContaining({ variant: 'error' })
      )
    );
  });
});
