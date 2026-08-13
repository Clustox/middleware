jest.mock('@/hooks/useAuth', () => ({ useAuth: jest.fn() }));
jest.mock('../useTeamRepoProjectMapping', () => ({
  useTeamRepoProjectMapping: jest.fn()
}));

import { screen } from '@testing-library/react';
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

  it('shows every repo as a row with a chip per available project, plus "No project"', () => {
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

    expect(screen.getByText('payments-api')).toBeInTheDocument();
    expect(screen.getByText('No project')).toBeInTheDocument();
    expect(screen.getByText('PAY — Payments Core')).toBeInTheDocument();
    expect(screen.getByText('PAYUI — Payments Frontend')).toBeInTheDocument();
  });

  it('calls setMapping with the project id when a project chip is clicked', async () => {
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

    await userEvent.click(screen.getByText('PAY — Payments Core'));

    expect(setMapping).toHaveBeenCalledWith('repo-1', 'project-a');
  });

  it('calls setMapping with null when "No project" is clicked on an already-mapped repo', async () => {
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

    await userEvent.click(screen.getByText('No project'));

    expect(setMapping).toHaveBeenCalledWith('repo-1', null);
  });

  it('shows a warning with the unmapped repo count when any repo has no project', () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    (useTeamRepoProjectMapping as jest.Mock).mockReturnValue({
      ...baseConfig,
      rows: [
        { org_repo_id: 'repo-1', repo_name: 'payments-api', org_project_id: null }
      ],
      unmappedCount: 1
    });
    render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    expect(
      screen.getByText('1 repo not mapped to a project yet')
    ).toBeInTheDocument();
  });

  it('does not show the unmapped warning when every repo is mapped', () => {
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
      unmappedCount: 0
    });
    render(<TeamRepoProjectMapping teamId={TEAM_ID} />);

    expect(screen.queryByText(/not mapped to a project/)).not.toBeInTheDocument();
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
