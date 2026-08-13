jest.mock('@/hooks/useAuth', () => ({ useAuth: jest.fn() }));
jest.mock('../useTeamRepoProjectMapping', () => ({
  useTeamRepoProjectMapping: jest.fn()
}));

import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useAuth } from '@/hooks/useAuth';
import { renderWithTheme as render } from '@/utils/testUtils';

import { TeamRepoProjectMapping } from '../TeamRepoProjectMapping';
import {
  RepoMappingRow,
  useTeamRepoProjectMapping
} from '../useTeamRepoProjectMapping';

const TEAM_ID = 'team-1';

const PROJECT_A = {
  id: 'project-a',
  key: 'PAY',
  name: 'Payments Core',
  provider: 'jira',
  idempotency_key: 'jira:org-1:project-a'
};
const PROJECT_B = {
  id: 'project-b',
  key: 'PAYUI',
  name: 'Payments Frontend',
  provider: 'jira',
  idempotency_key: 'jira:org-1:project-b'
};

const baseConfig = {
  rows: [] as RepoMappingRow[],
  projectOptions: [PROJECT_A, PROJECT_B],
  hasProjectOptions: true,
  unmappedCount: 0,
  setMapping: jest.fn(),
  isLoading: false,
  isSaving: false,
  onSave: jest.fn()
};

describe('TeamRepoProjectMapping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useTeamRepoProjectMapping as jest.Mock).mockReturnValue(baseConfig);
  });

  it('renders nothing when there is no team_id yet', () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    const { container } = render(<TeamRepoProjectMapping teamId={undefined} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when Jira is not linked for this org', () => {
    (useAuth as jest.Mock).mockReturnValue({ integrations: {} });
    const { container } = render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows a loading state while the mapping loads', () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    (useTeamRepoProjectMapping as jest.Mock).mockReturnValue({
      ...baseConfig,
      isLoading: true
    });
    render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    expect(
      screen.getByText('Loading repo → project mapping...')
    ).toBeInTheDocument();
  });

  it('renders nothing when the team has no repos at all', () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    (useTeamRepoProjectMapping as jest.Mock).mockReturnValue({
      ...baseConfig,
      rows: []
    });
    const { container } = render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows one table row per repo, with its own project dropdown', () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    (useTeamRepoProjectMapping as jest.Mock).mockReturnValue({
      ...baseConfig,
      rows: [
        { org_repo_id: 'repo-1', repo_name: 'payments-api', org_project_id: null },
        {
          org_repo_id: 'repo-2',
          repo_name: 'payments-web',
          org_project_id: 'project-b'
        }
      ]
    });
    render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    expect(screen.getByText('payments-api')).toBeInTheDocument();
    expect(screen.getByText('payments-web')).toBeInTheDocument();
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
  });

  it('shows "No project" as the dropdown value for an unmapped repo', () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    (useTeamRepoProjectMapping as jest.Mock).mockReturnValue({
      ...baseConfig,
      rows: [
        { org_repo_id: 'repo-1', repo_name: 'payments-api', org_project_id: null }
      ]
    });
    render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    expect(within(screen.getByRole('combobox')).getByText('No project')).toBeInTheDocument();
  });

  it('shows the connected project as the dropdown value for a mapped repo', () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    (useTeamRepoProjectMapping as jest.Mock).mockReturnValue({
      ...baseConfig,
      rows: [
        {
          org_repo_id: 'repo-1',
          repo_name: 'payments-api',
          org_project_id: 'project-a'
        }
      ]
    });
    render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    expect(
      within(screen.getByRole('combobox')).getByText('PAY — Payments Core')
    ).toBeInTheDocument();
  });

  it('calls setMapping with the project id when an option is picked from the dropdown', async () => {
    const setMapping = jest.fn();
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    (useTeamRepoProjectMapping as jest.Mock).mockReturnValue({
      ...baseConfig,
      rows: [
        { org_repo_id: 'repo-1', repo_name: 'payments-api', org_project_id: null }
      ],
      setMapping
    });
    render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(
      await screen.findByRole('option', { name: 'PAY — Payments Core' })
    );

    expect(setMapping).toHaveBeenCalledWith('repo-1', 'project-a');
  });

  it('calls setMapping with null when "No project" is picked on an already-mapped repo', async () => {
    const setMapping = jest.fn();
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    (useTeamRepoProjectMapping as jest.Mock).mockReturnValue({
      ...baseConfig,
      rows: [
        {
          org_repo_id: 'repo-1',
          repo_name: 'payments-api',
          org_project_id: 'project-a'
        }
      ],
      setMapping
    });
    render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'No project' }));

    expect(setMapping).toHaveBeenCalledWith('repo-1', null);
  });

  it('shows a warning icon next to any repo not mapped to a project', () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    (useTeamRepoProjectMapping as jest.Mock).mockReturnValue({
      ...baseConfig,
      rows: [
        { org_repo_id: 'repo-1', repo_name: 'payments-api', org_project_id: null }
      ]
    });
    render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    expect(
      screen.getByTitle('Not mapped to a project')
    ).toBeInTheDocument();
  });

  it('does not show a warning icon next to a mapped repo', () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    (useTeamRepoProjectMapping as jest.Mock).mockReturnValue({
      ...baseConfig,
      rows: [
        {
          org_repo_id: 'repo-1',
          repo_name: 'payments-api',
          org_project_id: 'project-a'
        }
      ]
    });
    render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    expect(screen.queryByTitle('Not mapped to a project')).not.toBeInTheDocument();
  });

  it('shows the connected-count summary in the section header', () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    (useTeamRepoProjectMapping as jest.Mock).mockReturnValue({
      ...baseConfig,
      rows: [
        {
          org_repo_id: 'repo-1',
          repo_name: 'payments-api',
          org_project_id: 'project-a'
        },
        { org_repo_id: 'repo-2', repo_name: 'payments-web', org_project_id: null }
      ],
      unmappedCount: 1
    });
    render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    expect(screen.getByText('1 of 2 repos connected to a project')).toBeInTheDocument();
  });

  it('prompts to select a Jira project first when the team has none', () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    (useTeamRepoProjectMapping as jest.Mock).mockReturnValue({
      ...baseConfig,
      rows: [
        { org_repo_id: 'repo-1', repo_name: 'payments-api', org_project_id: null }
      ],
      projectOptions: [],
      hasProjectOptions: false
    });
    render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    expect(
      screen.getByText(/Select at least one Jira project/)
    ).toBeInTheDocument();
    expect(screen.queryByText('payments-api')).not.toBeInTheDocument();
  });

  it('calls onSave when the Save mapping button is clicked', async () => {
    const onSave = jest.fn();
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    (useTeamRepoProjectMapping as jest.Mock).mockReturnValue({
      ...baseConfig,
      rows: [
        { org_repo_id: 'repo-1', repo_name: 'payments-api', org_project_id: null }
      ],
      onSave
    });
    render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    await userEvent.click(screen.getByRole('button', { name: /save mapping/i }));

    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
