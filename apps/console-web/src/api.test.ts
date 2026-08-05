import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAccessToken = vi.fn();
const reportUnauthorized = vi.fn();
vi.mock('./auth/authStore.js', () => ({
  getAccessToken: () => getAccessToken(),
  reportUnauthorized: () => reportUnauthorized(),
}));

import { apiFetch, api, tierHistoryApi, auditApi } from './api.js';

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

// Ticket #78: these call sites used to hit the global `fetch` directly, bypassing apiFetch —
// so a 401 on any of them failed silently instead of surfacing the Session-expired card. Each
// case here just needs to prove the call now goes through apiFetch (attaches the token,
// reports a 401), not re-test apiFetch's own behavior, which the suite above already covers.
describe('settings/audit/tier-history calls go through apiFetch', () => {
  beforeEach(() => {
    getAccessToken.mockReset().mockReturnValue('tok123');
    reportUnauthorized.mockReset();
  });

  it('attaches the access token on api.getSettings', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    await api.getSettings();

    expect(fetchMock).toHaveBeenCalledWith('/api/settings', { headers: { Authorization: 'Bearer tok123' } });
  });

  it('flags the session as expired when api.saveBasicSettings gets a 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    await api.saveBasicSettings({ tier1PromotionThreshold: 2, tier1AuditSampleRate: 10 }).catch(() => {});

    expect(reportUnauthorized).toHaveBeenCalled();
  });

  it('attaches the access token on api.proposeAdvancedSettings and api.confirmAdvancedSettings', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const advanced = { maxFollowups: 2, minDaysBetweenFollowups: 5, sentimentConfidenceFloor: 'Medium' as const };

    await api.proposeAdvancedSettings(advanced);
    await api.confirmAdvancedSettings(advanced);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/advanced',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok123' }) }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/advanced/confirm',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok123' }) }),
    );
  });

  it('flags the session as expired when tierHistoryApi.list gets a 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    await tierHistoryApi.list('acc_1').catch(() => {});

    expect(reportUnauthorized).toHaveBeenCalled();
  });

  it('attaches the access token on auditApi.list and auditApi.mark', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    await auditApi.list();
    await auditApi.mark('aud_1', 'fine');

    expect(fetchMock).toHaveBeenCalledWith('/api/audit-samples', { headers: { Authorization: 'Bearer tok123' } });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/audit-samples/aud_1/mark',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok123' }) }),
    );
  });

  it('flags the session as expired when auditApi.list gets a 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));

    await auditApi.list().catch(() => {});

    expect(reportUnauthorized).toHaveBeenCalled();
  });
});
