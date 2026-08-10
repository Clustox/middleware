import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { signIn } from 'next-auth/react';

import Login from '../login';

jest.mock('next-auth/react', () => ({ signIn: jest.fn() }));

/**
 * Covers the fix for "GitHub shows not-linked right after login, until a
 * hard refresh" (commit "bug: github link issue"). Root cause: AuthProvider
 * fetches /api/auth/session exactly once, on mount -- since it's mounted at
 * the app root (above /login itself), it had already fetched and cached the
 * pre-login (unauthenticated) session before sign-in happened. A client-side
 * route change (router.replace) doesn't remount it, so every org-scoped
 * read -- integrations included -- kept serving that stale snapshot. These
 * tests assert the fix (a full navigation) rather than the old behavior.
 */
describe('Login', () => {
  const assignMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { assign: assignMock }
    });
  });

  const fillAndSubmit = async (email = 'admin@clustox.com', password = 'correct-password') => {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), email);
    await user.type(screen.getByLabelText(/^password/i), password);
    await user.click(screen.getByRole('button', { name: /sign in/i }));
  };

  it('navigates with a full page load (not a client-side route change) on a successful sign-in', async () => {
    (signIn as jest.Mock).mockResolvedValue({ error: null, ok: true });
    render(<Login />);

    await fillAndSubmit();

    // The whole point of the fix: this must be window.location, not
    // next/router -- a router.replace here would remount nothing and
    // reintroduce the stale-session bug.
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith('/'));
  });

  it('calls signIn with redirect:false so the component controls navigation itself', async () => {
    (signIn as jest.Mock).mockResolvedValue({ error: null });
    render(<Login />);

    await fillAndSubmit('admin@clustox.com', 'correct-password');

    expect(signIn).toHaveBeenCalledWith('credentials', {
      email: 'admin@clustox.com',
      password: 'correct-password',
      redirect: false
    });
  });

  it('shows an error and does not navigate when the credentials are rejected', async () => {
    (signIn as jest.Mock).mockResolvedValue({ error: 'CredentialsSignin' });
    render(<Login />);

    await fillAndSubmit();

    expect(await screen.findByText(/invalid email or password/i)).toBeInTheDocument();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('shows a generic error and does not navigate when signIn itself throws', async () => {
    (signIn as jest.Mock).mockRejectedValue(new Error('network down'));
    render(<Login />);

    await fillAndSubmit();

    expect(
      await screen.findByText(/something went wrong/i)
    ).toBeInTheDocument();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('does not distinguish signIn throwing from a bad password in the message shown', async () => {
    // CLUSTOX FIX (see login.tsx comment): both must read as the same
    // generic error, never revealing which case happened.
    (signIn as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
    render(<Login />);

    await fillAndSubmit();

    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  });

  it('disables the submit button while the request is in flight', async () => {
    let resolveSignIn: (v: unknown) => void = () => {};
    (signIn as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveSignIn = resolve;
      })
    );
    render(<Login />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), 'admin@clustox.com');
    await user.type(screen.getByLabelText(/^password/i), 'correct-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();

    resolveSignIn({ error: null });
    await waitFor(() => expect(assignMock).toHaveBeenCalled());
  });
});
