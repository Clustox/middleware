jest.mock('@/hooks/useAuth', () => ({ useAuth: jest.fn() }));
jest.mock('@/hooks/useFeature', () => ({ useFeature: jest.fn() }));
jest.mock('@/contexts/ModalContext', () => ({ useModal: jest.fn() }));
jest.mock('@/components/JiraConnectionsManager', () => ({
  JiraConnectionsManager: () => <div>jira-connections-manager-stub</div>
}));
jest.mock('@/content/Dashboards/useIntegrationHandlers', () => ({
  useIntegrationHandlers: jest.fn()
}));
jest.mock('@/store', () => ({
  useDispatch: jest.fn(),
  useSelector: jest.fn()
}));
jest.mock('notistack', () => ({ useSnackbar: jest.fn() }));
jest.mock('@/slices/auth', () => ({ fetchCurrentOrg: jest.fn(() => ({ type: 'mock' })) }));

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSnackbar } from 'notistack';

import { JiraIntegrationCard } from '@/content/Dashboards/JiraIntegrationCard';
import { useIntegrationHandlers } from '@/content/Dashboards/useIntegrationHandlers';
import { useModal } from '@/contexts/ModalContext';
import { useAuth } from '@/hooks/useAuth';
import { useFeature } from '@/hooks/useFeature';
import { useDispatch, useSelector } from '@/store';
import { renderWithTheme as render } from '@/utils/testUtils';

const link = { jira: jest.fn() };
const unlink = { jira: jest.fn().mockResolvedValue(undefined) };

// CLUSTOX: docs/JIRA_MULTI_ACCOUNT_PLAN.md -- this card now branches on
// show_jira_multi_account. These tests exercise the legacy link/unlink
// flow specifically, so the flag is pinned off here; see the
// "multi-account mode" describe block below for the other branch.
describe('JiraIntegrationCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useFeature as jest.Mock).mockReturnValue(false);
    (useModal as jest.Mock).mockReturnValue({ addModal: jest.fn() });
    (useIntegrationHandlers as jest.Mock).mockReturnValue({ link, unlink });
    (useSelector as jest.Mock).mockReturnValue(false); // requests.org !== REQUEST
    (useDispatch as jest.Mock).mockReturnValue(jest.fn());
    (useSnackbar as jest.Mock).mockReturnValue({ enqueueSnackbar: jest.fn() });
  });

  it('shows "Link" and no Linked badge when integrations.jira is falsy', () => {
    (useAuth as jest.Mock).mockReturnValue({ integrations: {} });
    render(<JiraIntegrationCard />);

    expect(screen.getByText('Link')).toBeInTheDocument();
    expect(screen.queryByTestId('jira-linked-badge')).not.toBeInTheDocument();
  });

  it('shows "Unlink" and the Linked badge when integrations.jira is truthy', () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    render(<JiraIntegrationCard />);

    expect(screen.getByText('Unlink')).toBeInTheDocument();
    expect(screen.getByTestId('jira-linked-badge')).toBeInTheDocument();
  });

  it('opens the Configure Jira modal via link.jira() when not yet linked', async () => {
    (useAuth as jest.Mock).mockReturnValue({ integrations: {} });
    render(<JiraIntegrationCard />);

    await userEvent.click(screen.getByText('Link'));

    expect(link.jira).toHaveBeenCalledTimes(1);
    expect(unlink.jira).not.toHaveBeenCalled();
  });

  it('asks for confirmation before unlinking, and does nothing if declined', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    render(<JiraIntegrationCard />);

    await userEvent.click(screen.getByText('Unlink'));

    expect(confirmSpy).toHaveBeenCalled();
    expect(unlink.jira).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('unlinks and shows a success snackbar when confirmed', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    const enqueueSnackbar = jest.fn();
    (useSnackbar as jest.Mock).mockReturnValue({ enqueueSnackbar });
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    render(<JiraIntegrationCard />);

    await userEvent.click(screen.getByText('Unlink'));

    expect(unlink.jira).toHaveBeenCalledTimes(1);
    expect(enqueueSnackbar).toHaveBeenCalledWith(
      'Jira unlinked successfully',
      expect.objectContaining({ variant: 'success' })
    );
  });

  it('shows a failure snackbar, not a thrown error, when unlink rejects', async () => {
    (useAuth as jest.Mock).mockReturnValue({
      integrations: { jira: { integrated: true } }
    });
    unlink.jira.mockRejectedValueOnce(new Error('network down'));
    const enqueueSnackbar = jest.fn();
    (useSnackbar as jest.Mock).mockReturnValue({ enqueueSnackbar });
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    render(<JiraIntegrationCard />);

    await userEvent.click(screen.getByText('Unlink'));

    expect(
      await screen.findByText((t) => t === 'Unlink')
    ).toBeInTheDocument();
    expect(enqueueSnackbar).toHaveBeenCalledWith(
      'Failed to unlink Jira',
      expect.objectContaining({ variant: 'error' })
    );
  });
});

describe('JiraIntegrationCard in multi-account mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useFeature as jest.Mock).mockReturnValue(true);
    (useIntegrationHandlers as jest.Mock).mockReturnValue({ link, unlink });
    (useSelector as jest.Mock).mockReturnValue(false);
    (useDispatch as jest.Mock).mockReturnValue(jest.fn());
    (useSnackbar as jest.Mock).mockReturnValue({ enqueueSnackbar: jest.fn() });
    (useAuth as jest.Mock).mockReturnValue({ integrations: {} });
  });

  it('shows a single "Manage connections" action, not Link/Unlink', () => {
    (useModal as jest.Mock).mockReturnValue({ addModal: jest.fn() });
    render(<JiraIntegrationCard />);

    expect(
      screen.getByRole('button', { name: 'Manage connections' })
    ).toBeInTheDocument();
    expect(screen.queryByText('Link')).not.toBeInTheDocument();
    expect(screen.queryByText('Unlink')).not.toBeInTheDocument();
  });

  it('opens the connections manager modal on click', async () => {
    const addModal = jest.fn();
    (useModal as jest.Mock).mockReturnValue({ addModal });
    render(<JiraIntegrationCard />);

    await userEvent.click(
      screen.getByRole('button', { name: 'Manage connections' })
    );

    expect(addModal).toHaveBeenCalledTimes(1);
    expect(addModal).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Jira connections' })
    );
  });
});
