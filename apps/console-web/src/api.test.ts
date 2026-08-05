import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAccessToken = vi.fn();
const reportUnauthorized = vi.fn();
vi.mock('./auth/authStore.js', () => ({
  getAccessToken: () => getAccessToken(),
  reportUnauthorized: () => reportUnauthorized(),
}));

import { apiFetch } from './api.js';

describe('apiFetch', () => {
  beforeEach(() => {
    getAccessToken.mockReset();
    reportUnauthorized.mockReset();
  });

  it('calls fetch with a single argument (no headers) when there is no access token', async () => {
    getAccessToken.mockReturnValue(null);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/queue');

    expect(fetchMock).toHaveBeenCalledWith('/api/queue');
  });

  it('attaches a Bearer Authorization header when an access token exists', async () => {
    getAccessToken.mockReturnValue('tok123');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/queue');

    expect(fetchMock).toHaveBeenCalledWith('/api/queue', { headers: { Authorization: 'Bearer tok123' } });
  });

  it('preserves caller-supplied method and headers alongside the Authorization header', async () => {
    getAccessToken.mockReturnValue('tok123');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/accounts/1/messages/2/approve', { method: 'POST' });

    expect(fetchMock).toHaveBeenCalledWith('/api/accounts/1/messages/2/approve', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok123' },
    });
  });

  it('flags the session as expired on a 401 response', async () => {
    getAccessToken.mockReturnValue('stale-tok');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    await apiFetch('/api/queue');

    expect(reportUnauthorized).toHaveBeenCalled();
  });

  it('does not flag the session as expired on an unrelated error status', async () => {
    getAccessToken.mockReturnValue('tok');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    await apiFetch('/api/queue');

    expect(reportUnauthorized).not.toHaveBeenCalled();
  });
});
