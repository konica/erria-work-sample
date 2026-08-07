import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResolutionSection } from './ResolutionSection.js';

const items = [
  {
    id: 'res_2',
    actionTaken: 'Sent an indicative quote by phone',
    outcomeTag: 'closed_won',
    rule: 'pricing_question',
    resolvedAt: '2026-08-01T00:00:00.000Z',
    timeToResolution: '4h',
    followupSentAt: '2026-08-01T02:00:00.000Z',
  },
  {
    id: 'res_1',
    actionTaken: 'Marked resolved',
    outcomeTag: 'no_response',
    rule: 'negative_sentiment',
    resolvedAt: '2026-07-20T00:00:00.000Z',
    timeToResolution: '2d 3h',
    followupSentAt: null,
  },
];

describe('ResolutionSection', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items }) }));
  });

  it('renders one row per closed escalation with action, outcome, follow-up, and time-to-resolution', async () => {
    render(<ResolutionSection accountId="acc_1" />);

    await waitFor(() =>
      expect(screen.getByText('Sent an indicative quote by phone')).toBeInTheDocument(),
    );
    expect(screen.getByText('Marked resolved')).toBeInTheDocument();

    expect(document.querySelectorAll('[data-od-id="resolution-row"]')).toHaveLength(2);
    expect(screen.getByText('Closed-won')).toBeInTheDocument();
    expect(screen.getByText('No response')).toBeInTheDocument();
    expect(screen.getByText('4h')).toBeInTheDocument();
    expect(screen.getByText('2d 3h')).toBeInTheDocument();
  });

  it('shows whether a follow-up was sent for each record', async () => {
    render(<ResolutionSection accountId="acc_1" />);

    await waitFor(() => expect(screen.getAllByText(/yes|no/i).length).toBeGreaterThan(0));
    const rows = document.querySelectorAll('[data-od-id="resolution-row"]');
    expect(rows[0].textContent).toMatch(/yes/i);
    expect(rows[1].textContent).toMatch(/no/i);
  });

  it('shows an explicit empty state instead of a blank tab', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }));

    render(<ResolutionSection accountId="acc_1" />);

    await waitFor(() =>
      expect(screen.getByText(/no closed escalations yet/i)).toBeInTheDocument(),
    );
    expect(document.querySelector('[data-od-id="resolution-row"]')).not.toBeInTheDocument();
  });
});
