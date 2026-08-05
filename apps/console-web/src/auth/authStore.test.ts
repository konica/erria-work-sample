import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('./oidcClient.js', () => ({
  userManager: {
    events: {
      addUserLoaded: vi.fn(),
      addAccessTokenExpired: vi.fn(),
    },
    signinRedirect: vi.fn().mockResolvedValue(undefined),
    signinRedirectCallback: vi.fn().mockResolvedValue(undefined),
    signoutRedirect: vi.fn().mockResolvedValue(undefined),
    getUser: vi.fn().mockResolvedValue(null),
    removeUser: vi.fn().mockResolvedValue(undefined),
  },
}));

// authStore.ts memoizes initAuth()'s promise at module scope and registers its two event
// listeners once per import, so each test needs a fresh authStore module. But vi.mock's
// factory only runs once for the whole file — vi.resetModules() re-evaluates authStore.ts
// (a real module) yet hands back the *same* mocked oidcClient.js singleton every time, so its
// mock functions' call histories and mockResolvedValue overrides accumulate across tests
// unless cleared here, before authStore.ts re-registers its listeners.
async function freshModules() {
  vi.resetModules();
  const { userManager } = await import('./oidcClient.js');
  (userManager.events.addUserLoaded as Mock).mockClear();
  (userManager.events.addAccessTokenExpired as Mock).mockClear();
  (userManager.signinRedirect as Mock).mockClear().mockResolvedValue(undefined);
  (userManager.signinRedirectCallback as Mock).mockClear().mockResolvedValue(undefined);
  (userManager.signoutRedirect as Mock).mockClear().mockResolvedValue(undefined);
  (userManager.getUser as Mock).mockClear().mockResolvedValue(null);
  (userManager.removeUser as Mock).mockClear().mockResolvedValue(undefined);

  const authStore = await import('./authStore.js');
  return { userManager, ...authStore };
}

describe('authStore', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('shows the Landing state when there is no persisted user and no Keycloak callback in the URL', async () => {
    const { initAuth, getSnapshot, userManager } = await freshModules();
    await initAuth();
    expect(getSnapshot().view).toBe('landing');
    expect(userManager.getUser).toHaveBeenCalled();
  });

  it('restores an authenticated session from a valid persisted user', async () => {
    const { userManager, initAuth, getSnapshot, getAccessToken } = await freshModules();
    (userManager.getUser as Mock).mockResolvedValue({ access_token: 'tok', expired: false });
    await initAuth();
    expect(getSnapshot().view).toBe('authenticated');
    expect(getAccessToken()).toBe('tok');
  });

  it('treats a persisted but expired user as a session-expired state, not a fresh landing', async () => {
    const { userManager, initAuth, getSnapshot } = await freshModules();
    (userManager.getUser as Mock).mockResolvedValue({ access_token: 'tok', expired: true });
    await initAuth();
    expect(getSnapshot().view).toBe('expired');
  });

  it('completes the Keycloak redirect callback, strips the query string, and lets addUserLoaded flip the view', async () => {
    window.history.replaceState({}, '', '/?code=abc&state=xyz');
    const { userManager, initAuth, getSnapshot } = await freshModules();
    await initAuth();
    expect(userManager.signinRedirectCallback).toHaveBeenCalled();
    expect(window.location.search).toBe('');

    const onUserLoaded = (userManager.events.addUserLoaded as Mock).mock.calls[0][0];
    onUserLoaded({ access_token: 'fresh-token', expired: false });
    expect(getSnapshot().view).toBe('authenticated');
  });

  it('shows the signed-out state once, right after a logout redirect lands back, and clears the flag', async () => {
    sessionStorage.setItem('erria-just-logged-out', '1');
    const { initAuth, getSnapshot } = await freshModules();
    await initAuth();
    expect(getSnapshot().view).toBe('loggedOut');
    expect(sessionStorage.getItem('erria-just-logged-out')).toBeNull();
  });

  it('login() moves to the Redirecting state and starts the Keycloak redirect', async () => {
    const { userManager, login, getSnapshot } = await freshModules();
    await login();
    expect(getSnapshot().view).toBe('redirecting');
    expect(userManager.signinRedirect).toHaveBeenCalled();
  });

  it('logout() sets the just-logged-out flag before starting the RP-initiated logout redirect', async () => {
    const { userManager, logout } = await freshModules();
    await logout();
    expect(sessionStorage.getItem('erria-just-logged-out')).toBe('1');
    expect(userManager.signoutRedirect).toHaveBeenCalled();
  });

  it('reportUnauthorized tears down an authenticated session and marks it expired', async () => {
    const { userManager, initAuth, reportUnauthorized, getSnapshot } = await freshModules();
    (userManager.getUser as Mock).mockResolvedValue({ access_token: 'tok', expired: false });
    await initAuth();

    reportUnauthorized();

    expect(getSnapshot().view).toBe('expired');
    expect(userManager.removeUser).toHaveBeenCalled();
  });

  it('reportUnauthorized is a no-op outside an authenticated session', async () => {
    const { initAuth, reportUnauthorized, getSnapshot, userManager } = await freshModules();
    await initAuth(); // -> landing

    reportUnauthorized();

    expect(getSnapshot().view).toBe('landing');
    expect(userManager.removeUser).not.toHaveBeenCalled();
  });

  it("the library's own addAccessTokenExpired event flips an authenticated session to expired", async () => {
    const { userManager, initAuth, getSnapshot } = await freshModules();
    (userManager.getUser as Mock).mockResolvedValue({ access_token: 'tok', expired: false });
    await initAuth();

    const onExpired = (userManager.events.addAccessTokenExpired as Mock).mock.calls[0][0];
    onExpired();

    expect(getSnapshot().view).toBe('expired');
  });
});
