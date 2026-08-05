import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Ticket #78: an in-app action that hits an expired/invalid session must show the app-owned
// Session-expired card, not a silent redirect to Keycloak — and that has to hold for every
// console-api call, not just the ones #76 happened to wire through apiFetch first. This test
// deliberately exercises the Send Audit "mark" action, one of the calls that used to bypass
// apiFetch (see api.ts), to prove the fix rather than just the already-covered account/message
// actions. Only oidcClient is mocked — authStore, useAuth, and AuthGate all run for real so the
// 401 → expired-view transition is genuine, not asserted against a stub.
vi.mock('./auth/oidcClient.js', () => ({
  userManager: {
    events: {
      addUserLoaded: vi.fn(),
      addAccessTokenExpired: vi.fn(),
    },
    signinRedirect: vi.fn().mockResolvedValue(undefined),
    signinRedirectCallback: vi.fn().mockResolvedValue(undefined),
    signoutRedirect: vi.fn().mockResolvedValue(undefined),
    getUser: vi.fn().mockResolvedValue({ access_token: 'tok', expired: false }),
    removeUser: vi.fn().mockResolvedValue(undefined),
  },
}));

const sample = {
  id: 'aud_1',
  accountId: 'acc_1',
  company: 'Audited Co',
  body: 'Autonomously sent copy under review.',
  sentAt: '2026-08-01T00:00:00.000Z',
  sampledAt: '2026-08-01T00:00:00.000Z',
  reviewStatus: 'unreviewed' as const,
  reviewedBy: null,
};

describe('app-owned session-expired handling (ticket #78)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === '/api/nav-counts') return { ok: true, status: 200, json: async () => ({ review: 0, escalation: 0 }) };
        if (url === '/api/me') {
          return { ok: true, status: 200, json: async () => ({ sub: 'user-1', name: 'Test User', roles: ['reviewer'] }) };
        }
        if (url === '/api/queue') {
          return { ok: true, status: 200, json: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }) };
        }
        if (url === '/api/audit-samples') {
          return { ok: true, status: 200, json: async () => ({ items: [sample], total: 1, page: 1, pageSize: 20 }) };
        }
        if (url === '/api/audit-samples/aud_1/mark' && init?.method === 'POST') {
          return { ok: false, status: 401, json: async () => ({ message: 'Invalid or expired bearer token' }) };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );
  });

  it('shows the Session-expired card when an in-app action (marking a sampled send) hits a 401, instead of failing silently', async () => {
    // Import fresh so this file's real (non-mocked) authStore/useAuth start from a clean
    // module-scoped state rather than one left behind by another test file.
    vi.resetModules();
    const { App } = await import('./App.js');
    render(<App />);

    await waitFor(() => expect(screen.getByText('Account / Vessel')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /send audit/i }));
    await waitFor(() => expect(screen.getByText('Audited Co')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^Fine$/i }));

    await waitFor(() =>
      expect(screen.getByText('Your session has expired. Please sign in again.')).toBeInTheDocument(),
    );
    // Not a silent redirect: the app shows its own card with a Login CTA the user must click.
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(screen.queryByText('Audited Co')).not.toBeInTheDocument();
  });
});
