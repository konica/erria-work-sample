import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChangeTierPanel } from './ChangeTierPanel.js';

describe('ChangeTierPanel', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ account: { id: 'acc_1', currentTier: 2 } }) }),
    );
  });

  it('offers only Tier 2 and Tier 3, with a note that Tier 1 is earned', () => {
    render(<ChangeTierPanel accountId="acc_1" currentTier={3} onChanged={() => {}} onCancel={() => {}} />);

    expect(screen.getByRole('button', { name: /tier 2/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /tier 3/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /tier 1/i })).not.toBeInTheDocument();
    expect(screen.getByText(/earned through clean approvals/i)).toBeInTheDocument();
  });

  it('refuses to confirm without a reason', async () => {
    render(<ChangeTierPanel accountId="acc_1" currentTier={3} onChanged={() => {}} onCancel={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: /tier 2/i }));
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));

    expect(screen.getByText(/a reason is required/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('submits the change once a reason is given', async () => {
    const onChanged = vi.fn();
    render(<ChangeTierPanel accountId="acc_1" currentTier={3} onChanged={onChanged} onCancel={() => {}} />);

    await userEvent.click(screen.getByRole('button', { name: /tier 2/i }));
    await userEvent.type(screen.getByRole('textbox'), 'Pricing question resolved by AE');
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(2));
    expect(fetch).toHaveBeenCalledWith(
      '/api/accounts/acc_1/tier',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    render(<ChangeTierPanel accountId="acc_1" currentTier={3} onChanged={() => {}} onCancel={onCancel} />);

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
