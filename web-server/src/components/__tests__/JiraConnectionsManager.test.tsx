jest.mock('@/hooks/useClustoxUser', () => ({ useClustoxUser: jest.fn() }));
jest.mock('@/api-helpers/axios-api-instance', () => ({ handleApi: jest.fn() }));

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { handleApi } from '@/api-helpers/axios-api-instance';
import { JiraConnectionsManager } from '@/components/JiraConnectionsManager';
import { useClustoxUser } from '@/hooks/useClustoxUser';
import { JiraConnection } from '@/hooks/useJiraConnections';
import { renderWithTheme as render } from '@/utils/testUtils';

const ORG_ID = 'org-1';

const CONNECTION_A: JiraConnection = {
  id: 'conn-a',
  site_url: 'acme.atlassian.net',
  email: 'a@acme.com',
  is_default: true,
  provider_meta: {},
  created_at: null
};
const CONNECTION_B: JiraConnection = {
  id: 'conn-b',
  site_url: 'other.atlassian.net',
  email: 'b@other.com',
  is_default: false,
  provider_meta: {},
  created_at: null
};

// CLUSTOX: every request useJiraConnections makes is a GET (no explicit
// `method`) for the list, or an explicit post/delete/patch for a mutation --
// mirrors ConfigureJiraIncidentSourceModalBody.test.tsx's mockGets pattern.
const mockApi = (
  connections: JiraConnection[],
  overrides: Record<string, jest.Mock> = {}
) => {
  (handleApi as jest.Mock).mockImplementation((_url, params) => {
    const method = params?.method;
    if (!method) return Promise.resolve(connections);
    if (overrides[method]) return overrides[method](params);
    return Promise.resolve({});
  });
};

describe('JiraConnectionsManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useClustoxUser as jest.Mock).mockReturnValue({ orgId: ORG_ID });
  });

  it('lists connections with the default one marked', async () => {
    mockApi([CONNECTION_A, CONNECTION_B]);
    render(<JiraConnectionsManager />);

    await waitFor(() =>
      expect(screen.getByText('acme.atlassian.net')).toBeInTheDocument()
    );
    expect(screen.getByText('other.atlassian.net')).toBeInTheDocument();
    expect(
      screen.getByLabelText('Set other.atlassian.net as the default connection')
    ).not.toBeDisabled();
    expect(
      screen.getByLabelText('Set acme.atlassian.net as the default connection')
    ).toBeDisabled();
  });

  it('shows an empty state with no connections', async () => {
    mockApi([]);
    render(<JiraConnectionsManager />);

    await waitFor(() =>
      expect(screen.getByText('No Jira connections yet.')).toBeInTheDocument()
    );
  });

  it('requires all three fields before adding', async () => {
    mockApi([]);
    render(<JiraConnectionsManager />);
    await waitFor(() =>
      expect(screen.getByText('No Jira connections yet.')).toBeInTheDocument()
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(
      screen.getByText('Please fill in all three fields')
    ).toBeInTheDocument();
    expect(handleApi).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: 'post' })
    );
  });

  it('adds a connection and reloads the list', async () => {
    const post = jest.fn().mockResolvedValue({});
    mockApi([], { post });
    render(<JiraConnectionsManager />);
    await waitFor(() =>
      expect(screen.getByText('No Jira connections yet.')).toBeInTheDocument()
    );

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText('Jira Site URL'),
      'acme.atlassian.net'
    );
    await user.type(screen.getByLabelText('Email'), 'a@acme.com');
    await user.type(screen.getByLabelText('API Token'), 'secret-token');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'post',
          data: {
            site_url: 'acme.atlassian.net',
            email: 'a@acme.com',
            access_token: 'secret-token'
          }
        })
      )
    );
  });

  it('shows the server error message on a duplicate-account 409', async () => {
    const post = jest.fn().mockRejectedValue({
      status: 409,
      data: { message: 'a@acme.com is already connected to acme.atlassian.net' }
    });
    mockApi([], { post });
    render(<JiraConnectionsManager />);
    await waitFor(() =>
      expect(screen.getByText('No Jira connections yet.')).toBeInTheDocument()
    );

    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText('Jira Site URL'),
      'acme.atlassian.net'
    );
    await user.type(screen.getByLabelText('Email'), 'a@acme.com');
    await user.type(screen.getByLabelText('API Token'), 'secret-token');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(
        screen.getByText('a@acme.com is already connected to acme.atlassian.net')
      ).toBeInTheDocument()
    );
  });

  it('sets a connection as default', async () => {
    const patch = jest.fn().mockResolvedValue({});
    mockApi([CONNECTION_A, CONNECTION_B], { patch });
    render(<JiraConnectionsManager />);
    await waitFor(() =>
      expect(screen.getByText('other.atlassian.net')).toBeInTheDocument()
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByLabelText('Set other.atlassian.net as the default connection')
    );

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(expect.objectContaining({
        method: 'patch'
      }))
    );
  });

  it('asks for confirmation, then removes the connection', async () => {
    const del = jest.fn().mockResolvedValue({});
    mockApi([CONNECTION_A], { delete: del });
    render(<JiraConnectionsManager />);
    await waitFor(() =>
      expect(screen.getByText('acme.atlassian.net')).toBeInTheDocument()
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByLabelText('Remove the acme.atlassian.net connection')
    );

    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Remove connection' })
    );

    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'delete' })
      )
    );
  });

  it('shows the server error and keeps the row when delete is blocked (409)', async () => {
    const del = jest.fn().mockRejectedValue({
      status: 409,
      data: { message: 'JiraConnection still has projects synced from it' }
    });
    mockApi([CONNECTION_A], { delete: del });
    render(<JiraConnectionsManager />);
    await waitFor(() =>
      expect(screen.getByText('acme.atlassian.net')).toBeInTheDocument()
    );

    const user = userEvent.setup();
    await user.click(
      screen.getByLabelText('Remove the acme.atlassian.net connection')
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Remove connection' })
    );

    await waitFor(() =>
      expect(
        screen.getByText('JiraConnection still has projects synced from it')
      ).toBeInTheDocument()
    );
    expect(screen.getByText('acme.atlassian.net')).toBeInTheDocument();
  });

  it('does not add its own feature_flags param -- middleware.ts already does that for every request', async () => {
    // Regression test: a hand-added `feature_flags` param here used to
    // collide with the one middleware.ts appends globally, producing two
    // query params of the same name. Next parses that as an array, and
    // JSON.parse coerces the array to a comma-joined string, corrupting
    // the JSON right at the join point ("Unexpected non-whitespace
    // character..."). See useJiraConnections.ts's own comment.
    mockApi([]);
    render(<JiraConnectionsManager />);

    await waitFor(() => expect(handleApi).toHaveBeenCalled());
    const [, params] = (handleApi as jest.Mock).mock.calls[0];
    expect(params?.params).toBeUndefined();
  });
});
