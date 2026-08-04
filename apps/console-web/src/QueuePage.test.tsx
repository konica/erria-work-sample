import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    render(<QueuePage onOpenAccount={() => {}} />);
    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());
    expect(screen.getByText('MV Song Hong Pioneer')).toBeInTheDocument();
    expect(screen.getByText('Life-raft service window')).toBeInTheDocument();
    expect(screen.getByText('Tier 2')).toHaveClass('badge', 't2');
  });

  it('renders the row inside the styled q-table grid, not a bare <table>', async () => {
    render(<QueuePage onOpenAccount={() => {}} />);
    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());

    expect(document.querySelector('table.queue-table')).not.toBeInTheDocument();
    expect(document.querySelector('.q-table')).toBeInTheDocument();
    expect(document.querySelector('.q-head')).toBeInTheDocument();
    expect(screen.getByText('Song Hong Shipping').closest('.q-row')).toBeInTheDocument();
  });

  it('renders the ICP fit, tier rationale, and last-action fields the API provides', async () => {
    render(<QueuePage onOpenAccount={() => {}} />);
    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());

    expect(screen.getByText('High fit')).toBeInTheDocument();
    expect(screen.getByText('New account — rollout default')).toBeInTheDocument();
    expect(screen.getByText(new Date('2026-08-02T00:00:00.000Z').toLocaleString())).toBeInTheDocument();
  });

  it('opens the account when a row is clicked', async () => {
    const onOpenAccount = vi.fn();
    render(<QueuePage onOpenAccount={onOpenAccount} />);
    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Song Hong Shipping').closest('.q-row')!);

    expect(onOpenAccount).toHaveBeenCalledWith('acc_1');
  });
});
