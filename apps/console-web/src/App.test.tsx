import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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

describe('App', () => {
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

  it('renders the console shell — not the auth gate — once authenticated', async () => {
    useAuthMock.mockReturnValue({ view: 'authenticated', login: vi.fn(), logout: vi.fn() });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
      }),
    );

    render(<App />);

    expect(await screen.findByText('Erria')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log in' })).not.toBeInTheDocument();
  });
});
