/**
 * Regression coverage for "GitHub shows not-linked right after login, until
 * a hard refresh" (commit "bug: github link issue").
 *
 * Root cause: AuthProvider fetches /api/auth/session exactly once, on
 * mount. It's mounted at the app root, above /login itself, so it had
 * already fetched and cached the pre-login (unauthenticated) session
 * before sign-in happened. login.tsx used to navigate with a client-side
 * router.replace('/'), which doesn't remount AuthProvider -- every
 * org-scoped read, integrations included, kept serving that stale
 * snapshot until a manual hard refresh forced a remount. Fixed by
 * navigating with window.location.assign('/') instead (see login.tsx).
 *
 * This spec asserts the *symptom* a user actually sees -- what the
 * Integrations page shows on its very first paint after login, compared
 * against the backend's own ground truth -- rather than re-testing the
 * navigation mechanism itself (that's pages/__tests__/login.test.tsx's
 * job, as a Jest unit test).
 *
 * Running (see e2e/auth.spec.ts for why this needs a real browser, and
 * therefore the host or CI rather than the middleware-dev container):
 *   docker compose up -d
 *   cd web-server && yarn playwright test e2e/integration-link-status.spec.ts
 */
import { expect, test } from '@playwright/test';

const APP = 'http://localhost:3333';

const SUPERADMIN = {
  email: process.env.SUPERADMIN_EMAIL || 'admin@clustox.com',
  password: process.env.SUPERADMIN_PASSWORD || ''
};

test('the Integrations page reflects the real GitHub link status on first paint after login, without a refresh', async ({
  page
}) => {
  test.skip(!SUPERADMIN.password, 'SUPERADMIN_PASSWORD not set');
  // Next dev mode JIT-compiles each route on first hit, and the landing
  // dashboard's own data load can be slow too -- both well past
  // Playwright's 30s per-test default.
  test.setTimeout(180_000);

  // Sign in through the real UI -- this is the exact path the bug lived
  // in, so the test has to go through it rather than seeding a session
  // cookie directly.
  //
  // Login now navigates via window.location.assign (the fix), a real
  // full-page load rather than a client-side route change. Racing the
  // click against waitForNavigation (rather than polling page.url() after
  // the click resolves) is what makes this robust to that -- a poll can
  // land mid-navigation and throw "frame was detached" against the frame
  // that's mid-teardown.
  await page.goto(`${APP}/login`);
  await page.fill('input[type="email"]', SUPERADMIN.email);
  await page.fill('input[type="password"]', SUPERADMIN.password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load', timeout: 30_000 }),
    page.click('button[type="submit"]')
  ]);
  expect(new URL(page.url()).pathname.startsWith('/login')).toBe(false);

  // The sidebar is a temporary Drawer, closed by default
  // (SidebarContext's sidebarToggle starts false) -- PageHeader's hamburger
  // IconButton (role="navigation" in the markup) opens it. Clicking the
  // button itself, once it's actually present, is more robust than a
  // global keydown for "M": no dependency on a window-level listener
  // being attached yet, or focus being anywhere in particular.
  //
  // The post-login landing page shows its own "Getting app data" loading
  // state while it fetches dashboard data (real backend load, unrelated
  // to the fix) -- wait that out first, since the hamburger button itself
  // renders as part of the same page.
  await expect(page.getByText('Getting app data')).toHaveCount(0, {
    timeout: 90_000
  });
  await page.getByRole('navigation').click();

  const manageIntegrationsLink = page.getByRole('link', {
    name: 'Manage Integrations',
    exact: true
  });
  await expect(manageIntegrationsLink).toBeVisible({ timeout: 15_000 });

  // Ground truth, independent of whatever the page renders: what the
  // backend actually says for this org, right now. Fetched only after the
  // page has settled, for the same reason as above.
  const session = await (await page.request.get(`${APP}/api/auth/session`)).json();
  const orgId = session?.org?.id;
  expect(orgId, 'signed-in session should resolve an org').toBeTruthy();

  const map = await (
    await page.request.get(
      `${APP}/api/integrations/integrations-map?org_id=${orgId}`
    )
  ).json();
  const trulyLinked = Boolean(map.github);

  // Reach Integrations via a real client-side route change, not
  // page.goto() -- goto() is always a full navigation in Playwright, which
  // would remount AuthProvider fresh regardless of whether the fix exists
  // and trivially pass either way. Clicking the sidebar link is what
  // actually reproduces the scenario the bug lived in: login, then move
  // to another page within the same already-loaded app.
  await manageIntegrationsLink.click();
  await page.waitForURL(/\/integrations$/, { timeout: 15_000 });

  const githubCard = page.getByTestId('github-integration-card');
  await expect(githubCard).toBeVisible();

  if (trulyLinked) {
    await expect(githubCard.getByText('Unlink', { exact: true })).toBeVisible({
      timeout: 5_000
    });
  } else {
    await expect(githubCard.getByText('Link', { exact: true })).toBeVisible({
      timeout: 5_000
    });
  }
});
