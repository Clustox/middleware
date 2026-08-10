import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRouter } from 'next/router';
import { signIn } from 'next-auth/react';

import AcceptInvite from '../accept-invite';

jest.mock('next/router', () => ({ useRouter: jest.fn() }));
jest.mock('next-auth/react', () => ({ signIn: jest.fn() }));

/**
 * Same underlying fix as pages/__tests__/login.test.tsx, on the
 * post-signup sign-in path: accept-invite.tsx signs the new user straight
 * in after account creation, and that success path needs the same full
 * navigation (not router.replace) for AuthProvider to pick up the
 * now-valid session instead of continuing to serve whatever it had cached
 * pre-signup.
 */
describe('AcceptInvite — post-signup sign-in', () => {
  const assignMock = jest.fn();
  const routerReplaceMock = jest.fn();
  const PREVIEW = {
    email: 'newperson@clustox.com',
    name: 'Newperson',
    role: 'ADMIN' as const,
    orgName: null as string | null
  };

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { assign: assignMock }
    });
    (useRouter as jest.Mock).mockReturnValue({
      query: { token: 'a-valid-token' },
      isReady: true,
      replace: routerReplaceMock
    });
    global.fetch = jest.fn();
  });

  const fillPasswordFormAndSubmit = async () => {
    const user = userEvent.setup();
    await screen.findByText(/welcome, newperson/i);

    await user.type(screen.getByLabelText(/choose a password/i), 'a-strong-password-1');
    await user.type(screen.getByLabelText(/confirm password/i), 'a-strong-password-1');
    await user.click(screen.getByRole('button', { name: /create my account/i }));
  };

  it('navigates with a full page load after successfully signing the new account in', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => PREVIEW }) // preview GET on mount
      .mockResolvedValueOnce({ ok: true }); // accept-invite POST
    (signIn as jest.Mock).mockResolvedValue({ error: null });

    render(<AcceptInvite />);
    await fillPasswordFormAndSubmit();

    await waitFor(() => expect(assignMock).toHaveBeenCalledWith('/'));
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  it('signs in with the invited email, not anything user-entered', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => PREVIEW })
      .mockResolvedValueOnce({ ok: true });
    (signIn as jest.Mock).mockResolvedValue({ error: null });

    render(<AcceptInvite />);
    await fillPasswordFormAndSubmit();

    await waitFor(() =>
      expect(signIn).toHaveBeenCalledWith('credentials', {
        email: PREVIEW.email,
        password: 'a-strong-password-1',
        redirect: false
      })
    );
  });

  it('routes to /login (client-side) rather than assigning, when the sign-in after account creation fails', async () => {
    // Account creation itself succeeded -- only the immediate sign-in
    // failed. Falling back to the login page is a client-side nav here
    // deliberately: there is no session to pick up yet either way.
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => PREVIEW })
      .mockResolvedValueOnce({ ok: true });
    (signIn as jest.Mock).mockResolvedValue({ error: 'CredentialsSignin' });

    render(<AcceptInvite />);
    await fillPasswordFormAndSubmit();

    await waitFor(() => expect(routerReplaceMock).toHaveBeenCalledWith('/login'));
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('does not call signIn at all when account creation itself fails', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => PREVIEW })
      .mockResolvedValueOnce({ ok: false, status: 409 });

    render(<AcceptInvite />);
    await fillPasswordFormAndSubmit();

    await waitFor(() =>
      expect(
        screen.getByText(/account with this email already exists/i)
      ).toBeInTheDocument()
    );
    expect(signIn).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });
});
