import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Ticket #78: /api/me used to go through a bare `fetch`, so it never carried the access token
// and a 401 on it (session expired before the sidebar even finished mounting) failed silently
// instead of surfacing the app-owned Session-expired card.
const getAccessToken = vi.fn();
const reportUnauthorized = vi.fn();
vi.mock('../auth/authStore.js', () => ({
  getAccessToken: () => getAccessToken(),
  reportUnauthorized: () => reportUnauthorized(),
}));

import { useCurrentUser } from './useCurrentUser.js';

describe('useCurrentUser', () => {
  beforeEach(() => {
    getAccessToken.mockReset().mockReturnValue('tok123');
    reportUnauthorized.mockReset();
  });

  it('fetches /api/me with the access token attached', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ sub: 'user-1', name: 'Test User', roles: ['admin'] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCurrentUser());

    await waitFor(() => expect(result.current).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledWith('/api/me', { headers: { Authorization: 'Bearer tok123' } });
    expect(result.current?.roles).toEqual(['admin']);
  });

  it('flags the session as expired on a 401, instead of failing silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    renderHook(() => useCurrentUser());

    await waitFor(() => expect(reportUnauthorized).toHaveBeenCalled());
  });
});
