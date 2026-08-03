import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueuePage } from './QueuePage.js';

describe('QueuePage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [
            {
              accountId: 'acc_1',
              company: 'Song Hong Shipping',
              vessel: 'MV Song Hong Pioneer',
              contact: null,
              triggerSummary: 'Life-raft service window',
              icpBand: 'high',
              tier: 2,
              tierWhy: 'New account — rollout default',
              lastActionAt: '2026-08-02T00:00:00.000Z',
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        }),
      }),
    );
  });

  it('renders a queue row from the API', async () => {
    render(<QueuePage />);
    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());
    expect(screen.getByText('MV Song Hong Pioneer')).toBeInTheDocument();
    expect(screen.getByText('Tier 2')).toBeInTheDocument();
  });
});
