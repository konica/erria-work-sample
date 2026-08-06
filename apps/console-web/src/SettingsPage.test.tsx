import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingsPage } from './SettingsPage.js';

const settings = {
  basic: { tier1PromotionThreshold: 2, tier1AuditSampleRate: 10 },
  advanced: { maxFollowups: 2, minDaysBetweenFollowups: 5, sentimentConfidenceFloor: 'Medium' },
  locked: {
    hardTriggerRules: [
      { key: 'pricing_question', label: 'Pricing or commercial terms', description: 'No authority to quote.' },
    ],
    rolloutOverlayEnabled: true,
    rolloutOverlayDescription: 'Every new account starts at Tier 2 minimum.',
  },
  autonomous: { enabled: true, pauseReason: null },
};

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/advanced') && init?.method === 'PUT') {
          return {
            ok: true,
            json: async () => ({
              requiresConfirmation: true,
              diff: [{ field: 'maxFollowups', from: 2, to: 4 }],
              notice: 'These changes apply to outreach going forward.',
            }),
          };
        }
        if (url.endsWith('/autonomous/pause') && init?.method === 'POST') {
          return {
            ok: true,
            json: async () => ({ ...settings, autonomous: { enabled: false, pauseReason: 'Tone drift on three sends' } }),
          };
        }
        if (url.endsWith('/autonomous/resume') && init?.method === 'PUT') {
          return {
            ok: true,
            json: async () => ({
              requiresConfirmation: true,
              notice: 'Resuming lets Tier 1 accounts send without a human reading the message first.',
            }),
          };
        }
        if (url.endsWith('/autonomous/resume/confirm') && init?.method === 'POST') {
          return {
            ok: true,
            json: async () => ({ ...settings, autonomous: { enabled: true, pauseReason: null } }),
          };
        }
        return { ok: true, json: async () => settings };
      }),
    );
  });

  it('renders locked policy as read-only reference with no controls', async () => {
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText(/pricing or commercial terms/i)).toBeInTheDocument());
    const lockedSection = screen.getByTestId('locked-settings');
    expect(lockedSection.querySelectorAll('input, select, button')).toHaveLength(0);
  });

  it('saves freely-adjustable values without a confirmation step', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText(/promotion threshold/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/settings/basic', expect.objectContaining({ method: 'PUT' })),
    );
    expect(screen.queryByText(/applies to outreach going forward/i)).not.toBeInTheDocument();
  });

  it('shows the diff and the not-retroactive notice before applying advanced changes', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText(/promotion threshold/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /advanced/i }));
    await userEvent.clear(screen.getByLabelText(/max follow-ups/i));
    await userEvent.type(screen.getByLabelText(/max follow-ups/i), '4');
    await userEvent.click(screen.getByRole('button', { name: /save \(requires confirm\)/i }));

    await waitFor(() => expect(screen.getByText(/maxFollowups/i)).toBeInTheDocument());
    expect(screen.getByText(/2 → 4/)).toBeInTheDocument();
    expect(screen.getByText(/apply to outreach going forward/i)).toBeInTheDocument();
    // Nothing is applied until Confirm is clicked.
    expect(fetch).not.toHaveBeenCalledWith(
      '/api/settings/advanced/confirm',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not disturb basic values when confirming advanced changes, and vice versa', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText(/promotion threshold/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/settings/basic', expect.objectContaining({ method: 'PUT' })),
    );

    const basicCallBody = JSON.parse(
      (vi.mocked(fetch).mock.calls.find(([url]) => url === '/api/settings/basic')?.[1]?.body as string) ?? '{}',
    );
    expect(basicCallBody).toEqual({ tier1PromotionThreshold: 2, tier1AuditSampleRate: 10 });
  });

  it('applies advanced changes only after confirming', async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText(/promotion threshold/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /advanced/i }));
    await userEvent.clear(screen.getByLabelText(/max follow-ups/i));
    await userEvent.type(screen.getByLabelText(/max follow-ups/i), '4');
    await userEvent.click(screen.getByRole('button', { name: /save \(requires confirm\)/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /confirm & apply/i })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: /confirm & apply/i }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/settings/advanced/confirm',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('reports no confirmation needed and applies nothing when nothing changed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/advanced') && init?.method === 'PUT') {
          return { ok: true, json: async () => ({ requiresConfirmation: false, diff: [], notice: '' }) };
        }
        return { ok: true, json: async () => settings };
      }),
    );

    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText(/promotion threshold/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /advanced/i }));
    await userEvent.click(screen.getByRole('button', { name: /save \(requires confirm\)/i }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/settings/advanced', expect.objectContaining({ method: 'PUT' })),
    );
    expect(screen.queryByTestId('confirm-advanced')).not.toBeInTheDocument();
  });

  describe('autonomous kill switch', () => {
    it('pauses immediately once a reason is given, with no confirmation step', async () => {
      render(<SettingsPage />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /pause autonomous sending/i })).toBeInTheDocument(),
      );

      await userEvent.type(screen.getByLabelText(/why are you pausing/i), 'Tone drift on three sends');
      await userEvent.click(screen.getByRole('button', { name: /pause autonomous sending/i }));

      await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
          '/api/settings/autonomous/pause',
          expect.objectContaining({ method: 'POST' }),
        ),
      );
      await waitFor(() => expect(screen.getByText(/^paused$/i)).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /^confirm resume$/i })).not.toBeInTheDocument();
    });

    it('will not pause without a reason', async () => {
      render(<SettingsPage />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /pause autonomous sending/i })).toBeInTheDocument(),
      );

      await userEvent.click(screen.getByRole('button', { name: /pause autonomous sending/i }));

      expect(screen.getByText(/a reason is required/i)).toBeInTheDocument();
      expect(fetch).not.toHaveBeenCalledWith(
        '/api/settings/autonomous/pause',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('proposing a resume changes nothing until confirmed', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.endsWith('/autonomous/resume') && init?.method === 'PUT') {
            return {
              ok: true,
              json: async () => ({
                requiresConfirmation: true,
                notice: 'Resuming lets Tier 1 accounts send without a human reading the message first.',
              }),
            };
          }
          if (url.endsWith('/autonomous/resume/confirm') && init?.method === 'POST') {
            return { ok: true, json: async () => ({ ...settings, autonomous: { enabled: true, pauseReason: null } }) };
          }
          return { ok: true, json: async () => ({ ...settings, autonomous: { enabled: false, pauseReason: 'paused' } }) };
        }),
      );

      render(<SettingsPage />);
      await waitFor(() => expect(screen.getByText(/^paused$/i)).toBeInTheDocument());

      await userEvent.click(screen.getByRole('button', { name: /resume autonomous sending/i }));

      await waitFor(() =>
        expect(screen.getByText(/without a human reading the message first/i)).toBeInTheDocument(),
      );
      expect(fetch).not.toHaveBeenCalledWith(
        '/api/settings/autonomous/resume/confirm',
        expect.objectContaining({ method: 'POST' }),
      );

      await userEvent.click(screen.getByRole('button', { name: /^confirm resume$/i }));

      await waitFor(() =>
        expect(fetch).toHaveBeenCalledWith(
          '/api/settings/autonomous/resume/confirm',
          expect.objectContaining({ method: 'POST' }),
        ),
      );
    });
  });
});
