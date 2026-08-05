import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EscalationPanel } from './EscalationPanel.js';

const escalation = {
  id: 'esc_1',
  accountId: 'acc_1',
  company: 'Vinh Long Coastal',
  rule: 'pricing_question',
  reasonSummary: 'Buyer asked about pricing or commercial terms',
  recommendedNextStep: 'Hand to an AE for an indicative quote.',
  status: 'active' as const,
  repeatOfResolutionId: null,
  createdAt: '2026-08-01T00:00:00.000Z',
};

function mockFetch(overrides: { priors?: unknown[] } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/resolutions')) {
      return {
        ok: true,
        json: async () => ({
          items: overrides.priors ?? [
            {
              id: 'res_1',
              actionTaken: 'Sent quote — life-raft servicing',
              outcomeTag: 're_engaged',
              rule: 'pricing_question',
              resolvedAt: '2026-07-01T00:00:00.000Z',
            },
          ],
        }),
      };
    }
    if (url.includes('/link') && init?.method === 'POST') {
      return { ok: true, json: async () => ({ escalation: { id: 'esc_1', repeatOfResolutionId: 'res_1' } }) };
    }
    if (url.includes('/link') && init?.method === 'DELETE') {
      return { ok: true, json: async () => ({ escalation: { id: 'esc_1', repeatOfResolutionId: null } }) };
    }
    if (url.includes('/resolve')) {
      return { ok: true, json: async () => ({ escalation: { id: 'esc_1', status: 'resolved' } }) };
    }
    return { ok: true, json: async () => ({}) };
  });
}

describe('EscalationPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch());
  });

  it('shows the reason, the recommended next step, and that agent send is disabled', async () => {
    render(<EscalationPanel escalation={escalation} onResolved={() => {}} />);

    expect(screen.getByText(/buyer asked about pricing/i)).toBeInTheDocument();
    expect(screen.getByText(/hand to an ae/i)).toBeInTheDocument();
    expect(screen.getByText(/agent send is disabled/i)).toBeInTheDocument();
  });

  it('requires an outcome before marking resolved', async () => {
    render(<EscalationPanel escalation={escalation} onResolved={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: /mark resolved/i }));

    expect(screen.getByText(/choose an outcome/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/resolve'), expect.anything());
  });

  it('marks resolved once an outcome is supplied', async () => {
    const onResolved = vi.fn();
    render(<EscalationPanel escalation={escalation} onResolved={onResolved} />);

    await userEvent.click(screen.getByRole('button', { name: /re-engaged/i }));
    await userEvent.type(screen.getByLabelText(/action taken/i), 'Resolved by phone');
    await userEvent.click(screen.getByRole('button', { name: /mark resolved/i }));

    await waitFor(() => expect(onResolved).toHaveBeenCalled());
    expect(screen.getByText(/resolved by you/i)).toBeInTheDocument();
  });

  it('requires a reply body before composing and sending', async () => {
    render(<EscalationPanel escalation={escalation} onResolved={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: /re-engaged/i }));
    await userEvent.click(screen.getByRole('button', { name: /compose.*send/i }));

    expect(screen.getByText(/write the reply/i)).toBeInTheDocument();
  });

  it('links to a prior resolution only after previewing it', async () => {
    render(<EscalationPanel escalation={escalation} onResolved={() => {}} />);

    await waitFor(() => expect(screen.getByLabelText(/related to a prior resolution/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /link it/i })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/related to a prior resolution/i), 'res_1');

    const preview = document.querySelector('[data-od-id="repeat-link-preview"]');
    expect(preview?.textContent).toMatch(/sent quote — life-raft servicing/i);
    await userEvent.click(screen.getByRole('button', { name: /link it/i }));

    await waitFor(() => expect(screen.getByText(/repeat escalation/i)).toBeInTheDocument());
  });

  it('shows the already-linked state and allows unlinking', async () => {
    render(
      <EscalationPanel escalation={{ ...escalation, repeatOfResolutionId: 'res_1' }} onResolved={() => {}} />,
    );

    await waitFor(() => expect(screen.getByText(/repeat escalation/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /unlink/i }));

    await waitFor(() => expect(screen.queryByText(/repeat escalation/i)).not.toBeInTheDocument());
  });
});
