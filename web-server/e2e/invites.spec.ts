/**
 * Invite links.
 *
 * The link is a bearer credential handed to someone with no account, so the
 * properties worth testing are the ones that make it safe to send over Slack:
 * single use, expiring, revocable, and useless to anyone reading the database.
 *
 * Running:
 *   docker compose up -d
 *   cd web-server && yarn playwright test e2e/invites.spec.ts
 */
import { APIRequestContext, expect, request, test } from '@playwright/test';

const APP = 'http://localhost:3333';

const SUPERADMIN = {
  email: process.env.SUPERADMIN_EMAIL || 'admin@clustox.com',
  password: process.env.SUPERADMIN_PASSWORD || ''
};

const signIn = async (email: string, password: string) => {
  const ctx = await request.newContext({ baseURL: APP });
  const csrf = await (await ctx.get('/api/auth/csrf')).json();
  const res = await ctx.post('/api/auth/callback/credentials', {
    form: { csrfToken: csrf.csrfToken, email, password, json: 'true' },
    failOnStatusCode: false
  });
  expect(res.status(), `sign-in failed for ${email}`).toBe(200);
  return ctx;
};

const createdEmails: string[] = [];

const unique = (p: string) => {
  const email = `${p}.${Date.now()}${Math.floor(Math.random() * 1000)}@clustox.com`;
  createdEmails.push(email);
  return email;
};

const tokenFrom = (url: string) => url.split('token=')[1];

const invite = async (su: APIRequestContext, email: string, role = 'ADMIN') => {
  const res = await su.post('/api/clustox/invites', {
    data: { name: 'Invited Person', email, role }
  });
  expect(res.status()).toBe(200);
  return tokenFrom((await res.json()).invite_url);
};

test.describe('invite links', () => {
  test.skip(!SUPERADMIN.password, 'SUPERADMIN_PASSWORD not set');

  let su: APIRequestContext;
  let anon: APIRequestContext;
  // Accounts redeemed during the run, cleaned up afterwards so workspaces do
  // not accumulate across runs.
  const created = createdEmails;

  test.beforeAll(async () => {
    su = await signIn(SUPERADMIN.email, SUPERADMIN.password);
    // No cookies: an invitee has no account and therefore no session.
    anon = await request.newContext({ baseURL: APP });
  });

  test.afterAll(async () => {
    const users = await (await su.get('/api/clustox/users')).json();
    for (const u of users) {
      if (u.role === 'ADMIN' && created.includes(u.email)) {
        await su.fetch(`/api/clustox/users/${u.userId}`, {
          method: 'DELETE',
          failOnStatusCode: false
        });
      }
    }
  });

  test('only a superadmin can issue an invite', async () => {
    const email = unique('perm.check');
    const token = await invite(su, email);

    // Redeem it so the created admin can be used to test the restriction.
    await anon.post('/api/clustox/accept-invite', {
      data: { token, password: 'InvitedPersonPass123' }
    });
    const adminCtx = await signIn(email, 'InvitedPersonPass123');

    const res = await adminCtx.post('/api/clustox/invites', {
      data: { name: 'Nope', email: unique('nope'), role: 'ADMIN' },
      failOnStatusCode: false
    });
    expect(res.status()).toBe(403);
  });

  test('an invitee can preview and redeem without a session', async () => {
    const email = unique('redeem');
    const token = await invite(su, email);

    const preview = await anon.get(
      `/api/clustox/accept-invite?token=${token}`,
      { failOnStatusCode: false }
    );
    expect(preview.status()).toBe(200);
    expect((await preview.json()).email).toBe(email);

    const accept = await anon.post('/api/clustox/accept-invite', {
      data: { token, password: 'InvitedPersonPass123' },
      failOnStatusCode: false
    });
    expect(accept.status()).toBe(200);

    // and the password they chose actually works
    const ctx = await signIn(email, 'InvitedPersonPass123');
    const me = await (await ctx.get('/api/clustox/me')).json();
    expect(me.email).toBe(email);
    expect(me.role).toBe('ADMIN');
    expect(me.org_id).toBeTruthy();
  });

  test('a link cannot be redeemed twice', async () => {
    const token = await invite(su, unique('single.use'));

    const first = await anon.post('/api/clustox/accept-invite', {
      data: { token, password: 'InvitedPersonPass123' },
      failOnStatusCode: false
    });
    expect(first.status()).toBe(200);

    const second = await anon.post('/api/clustox/accept-invite', {
      data: { token, password: 'DifferentPersonPass123' },
      failOnStatusCode: false
    });
    expect(second.status()).toBe(404);
  });

  test('a revoked link stops working', async () => {
    const email = unique('revoked');
    const token = await invite(su, email);

    const pending = await (await su.get('/api/clustox/invites')).json();
    const row = pending.find((i: any) => i.email === email);
    expect(row).toBeTruthy();

    const del = await su.fetch(`/api/clustox/invites/${row.id}`, {
      method: 'DELETE'
    });
    expect(del.status()).toBe(200);

    const res = await anon.post('/api/clustox/accept-invite', {
      data: { token, password: 'InvitedPersonPass123' },
      failOnStatusCode: false
    });
    expect(res.status()).toBe(404);
  });

  test('an unknown token is rejected exactly like a spent one', async () => {
    // Identical responses, so guessing reveals nothing about which tokens
    // exist.
    const spent = await invite(su, unique('spent'));
    await anon.post('/api/clustox/accept-invite', {
      data: { token: spent, password: 'InvitedPersonPass123' }
    });

    const spentRes = await anon.get(
      `/api/clustox/accept-invite?token=${spent}`,
      { failOnStatusCode: false }
    );
    const unknownRes = await anon.get(
      '/api/clustox/accept-invite?token=deadbeefdeadbeef',
      { failOnStatusCode: false }
    );

    expect(spentRes.status()).toBe(unknownRes.status());
    expect(spentRes.status()).toBe(404);
  });

  test('inviting an email that already has an account is refused', async () => {
    const email = unique('dupe');
    const token = await invite(su, email);
    await anon.post('/api/clustox/accept-invite', {
      data: { token, password: 'InvitedPersonPass123' }
    });

    const res = await su.post('/api/clustox/invites', {
      data: { name: 'Dupe', email, role: 'ADMIN' },
      failOnStatusCode: false
    });
    expect(res.status()).toBe(409);
  });

  test('the accept page is reachable signed out', async () => {
    const token = await invite(su, unique('page'));
    const res = await anon.get(`/accept-invite?token=${token}`, {
      failOnStatusCode: false,
      maxRedirects: 0
    });
    // Not a redirect to /login: the invitee has no account to sign in with.
    expect(res.status()).toBe(200);
  });

  // CLUSTOX: regression coverage for the same underlying bug as
  // e2e/integration-link-status.spec.ts, on the post-signup sign-in path
  // (see accept-invite.tsx's "CLUSTOX FIX" comment). Every other test in
  // this file talks to the API directly and never touches AuthProvider's
  // client-side session cache at all, so none of them would have caught
  // this -- it only shows up through a real browser completing the actual
  // form-submit -> sign-in -> client-side-navigate sequence.
  test('a brand-new admin reaches a fully working, correctly-scoped Integrations page right after account creation, via the same client-side navigation the original bug lived in', async ({
    page
  }) => {
    test.skip(!SUPERADMIN.password, 'SUPERADMIN_PASSWORD not set');
    // Next dev mode JIT-compiles each route on first hit, which can take
    // 40-60s -- well past Playwright's 30s per-test default.
    test.setTimeout(120_000);

    const email = unique('e2e.browser');
    const token = await invite(su, email);
    const password = 'InvitedPersonPass123!';

    await page.goto(`${APP}/accept-invite?token=${token}`);
    await page.getByLabel('Choose a password').fill(password);
    await page.getByLabel('Confirm password').fill(password);

    // The fix: a full page load here, so AuthProvider (mounted at the app
    // root, above /login/accept-invite) re-fetches session with this
    // brand-new account's cookie instead of continuing to serve whatever
    // it cached before the account existed. Racing the click against
    // waitForNavigation (rather than polling page.url() afterwards) is
    // what makes this robust to that being a real navigation rather than
    // a client-side route change.
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 30_000 }),
      page.getByRole('button', { name: 'Create my account' }).click()
    ]);

    // Reproduces the original bug's exact repro shape: login/signup, land
    // on Welcome, then a client-side route change (clicking Continue,
    // which calls router.push) to Integrations -- not a fresh page load,
    // which would trivially remount everything and mask a staleness bug
    // regardless of whether the fix is in place.
    const continueBtn = page.getByRole('button', { name: 'Continue' });
    if (await continueBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await continueBtn.click();
    } else {
      await page.goto(`${APP}/integrations`, { waitUntil: 'domcontentloaded' });
    }

    // If AuthProvider were still stuck on its pre-signup ("no org")
    // snapshot, orgId would be undefined and this org-scoped page is
    // exactly where that shows up.
    await expect(page.getByText('Link your Code Services')).toBeVisible({
      timeout: 10_000
    });
    await expect(page.getByTestId('github-integration-card')).toBeVisible();

    const session = await (await page.request.get(`${APP}/api/auth/session`)).json();
    expect(session?.org?.id, 'the new admin should have their own workspace').toBeTruthy();
  });
});
