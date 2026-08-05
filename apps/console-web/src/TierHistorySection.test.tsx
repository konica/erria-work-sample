import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TierHistorySection } from './TierHistorySection.js';

const items = [
  {
    id: 'ev_2',
    eventType: 'manual_override',
    fromTier: 3,
    toTier: 2,
    reason: 'Pricing question resolved — by You (manual override).',
    occurredAt: '2026-08-01T00:00:00.000Z',
    isManual: true,
  },
  {
    id: 'ev_1',
    eventType: 'escalate',
    fromTier: 2,
    toTier: 3,
    reason: 'Buyer asked about pricing or commercial terms',
    occurredAt: '2026-07-20T00:00:00.000Z',
    isManual: false,
  },
];

describe('TierHistorySection', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items }) }));
  });

  it('renders every event newest first', async () => {
    render(<TierHistorySection accountId="acc_1" />);

    await waitFor(() => expect(screen.getByText(/pricing question resolved/i)).toBeInTheDocument());
    expect(screen.getByText(/buyer asked about pricing/i)).toBeInTheDocument();

    const titles = screen.getAllByText(/tier/i, { selector: '.tt' }).map((el) => el.textContent);
    expect(titles[0]).toMatch(/manually changed/i);
    expect(titles[1]).toMatch(/escalated/i);
  });

  it('tags human overrides distinctly from system-driven entries', async () => {
    render(<TierHistorySection accountId="acc_1" />);

    await waitFor(() => expect(document.querySelector('.tl-manual')).toBeInTheDocument());
    expect(document.querySelectorAll('.tl-manual')).toHaveLength(1);

    const manualItem = document.querySelector('.tl-item.manual');
    expect(manualItem).toBeInTheDocument();
    expect(manualItem?.textContent).toMatch(/pricing question resolved/i);

    const nonManualItems = document.querySelectorAll('.tl-item:not(.manual)');
    expect(nonManualItems).toHaveLength(1);
    expect(nonManualItems[0].querySelector('.tl-manual')).toBeNull();
  });

  it('renders a readable label for every event type, never a raw enum value', async () => {
    render(<TierHistorySection accountId="acc_1" />);

    await waitFor(() => expect(screen.getByText(/escalated to tier 3/i)).toBeInTheDocument());
    expect(screen.queryByText('escalate')).not.toBeInTheDocument();
    expect(screen.queryByText('manual_override')).not.toBeInTheDocument();
  });

  it('explains the empty state rather than showing a blank panel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) }));

    render(<TierHistorySection accountId="acc_1" />);

    await waitFor(() => expect(screen.getByText(/no tier changes recorded/i)).toBeInTheDocument());
  });
});
