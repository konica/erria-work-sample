import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from './App.js';

const initAuth = vi.fn().mockResolvedValue(undefined);
// useNavCounts (rendered inside AppShell once authenticated) calls apiFetch, which pulls
// getAccessToken/reportUnauthorized from this same module — stub the full surface, not just
// initAuth, or that call throws and the test only passes by accident of a swallowed error.
vi.mock('./auth/authStore.js', () => ({
  initAuth: () => initAuth(),
  getAccessToken: () => null,
  reportUnauthorized: () => {},
}));

const useAuthMock = vi.fn();
vi.mock('./auth/useAuth.js', () => ({ useAuth: () => useAuthMock() }));

function emptyList() {
  return { ok: true, json: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }) };
}

describe('App auth gating', () => {
  it('renders nothing while the initial session check is in flight, rather than flashing Landing', () => {
    useAuthMock.mockReturnValue({ view: 'loading', login: vi.fn(), logout: vi.fn() });

    const { container } = render(<App />);

    expect(container).toBeEmptyDOMElement();
    expect(initAuth).toHaveBeenCalled();
  });

  it('renders the auth gate when there is no active session', () => {
    useAuthMock.mockReturnValue({ view: 'landing', login: vi.fn(), logout: vi.fn() });

    render(<App />);

    expect(
      screen.getByText('Internal console for reviewing and sending AI-drafted customer outreach, and handling escalations.'),
    ).toBeInTheDocument();
  });
});

describe('App navigation', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({ view: 'authenticated', login: vi.fn(), logout: vi.fn() });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/nav-counts') {
          return { ok: true, json: async () => ({ review: 0, escalation: 0 }) };
        }
        return emptyList();
      }),
    );
  });

  it('shows the queue table by default — not the auth gate — once authenticated', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Account / Vessel')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Log in' })).not.toBeInTheDocument();
  });

  it('navigates to the Send Audit screen when its nav item is clicked', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Account / Vessel')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /send audit/i }));

    await waitFor(() => expect(screen.getByText(/no sampled sends yet/i)).toBeInTheDocument());
    expect(screen.queryByText('Account / Vessel')).not.toBeInTheDocument();
  });

  it('returns to the queue when its nav item is clicked again', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Account / Vessel')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /send audit/i }));
    await waitFor(() => expect(screen.getByText(/no sampled sends yet/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /account queue/i }));

    await waitFor(() => expect(screen.getByText('Account / Vessel')).toBeInTheDocument());
    expect(screen.queryByText(/no sampled sends yet/i)).not.toBeInTheDocument();
  });
});
