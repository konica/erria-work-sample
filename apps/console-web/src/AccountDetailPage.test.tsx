import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountDetailPage } from './AccountDetailPage.js';

const detail = {
  account: {
    id: 'acc_1',
    companyName: 'Song Hong Shipping',
    segment: 'Offshore support vessel operator',
    hub: 'Haiphong',
    icpBand: 'high',
    relationshipSummary: 'New account · first contact 12 Jul 2026',
    currentTier: 2,
    tierRationale: 'New account — rollout default',
  },
  vessels: [{ id: 'v1', name: 'MV Song Hong Pioneer', imo: '9123456', flag: 'Vietnam' }],
  contacts: [{ id: 'c1', name: 'Ms. Lan Pham', role: 'Technical Superintendent', email: 'lan@example.com' }],
  pendingMessage: { id: 'msg_1', body: 'Hi Ms. Pham, ...', edited: false, tierContext: 2 },
};

function mockFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url.endsWith('/approve')) {
      return { ok: true, json: async () => ({ message: { id: 'msg_1', status: 'approved' } }) };
    }
    if (init?.method === 'POST' && url.endsWith('/reject')) {
      return { ok: true, json: async () => ({ message: { id: 'msg_1', status: 'rejected' } }) };
    }
    if (init?.method === 'PATCH') {
      return {
        ok: true,
        json: async () => ({ message: { id: 'msg_1', body: 'Edited text', edited: true } }),
      };
    }
    return { ok: true, json: async () => ({ ...detail, ...overrides }) };
  });
}

describe('AccountDetailPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch());
  });

  it('renders the dossier and the pending draft', async () => {
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());
    expect(screen.getByText('MV Song Hong Pioneer')).toBeInTheDocument();
    expect(screen.getByText(/Hi Ms\. Pham/)).toBeInTheDocument();
  });

  it('renders inside the mockup detail-grid, not ad-hoc layout', async () => {
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());

    expect(document.querySelector('.detail-top')).toBeInTheDocument();
    expect(document.querySelector('.detail-grid')).toBeInTheDocument();
    expect(document.querySelector('.dossier')).toBeInTheDocument();
    expect(document.querySelector('.msg.draft')).toBeInTheDocument();
  });

  it('shows the sending state after approving', async () => {
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Hi Ms\. Pham/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /approve/i }));

    await waitFor(() => expect(screen.getByText(/approved · sending/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
  });

  it('shows the rejected state after rejecting', async () => {
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Hi Ms\. Pham/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /reject/i }));

    await waitFor(() => expect(screen.getByText(/rejected/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('edits the draft body and marks it edited', async () => {
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Hi Ms\. Pham/)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    const textarea = screen.getByRole('textbox');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, 'Edited text');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(screen.getByText('Edited text')).toBeInTheDocument());
    expect(screen.getByText(/edited by a human/i)).toBeInTheDocument();
  });

  it('shows no review controls when there is no pending draft', async () => {
    vi.stubGlobal('fetch', mockFetch({ pendingMessage: null }));
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.getByText(/nothing awaiting review/i)).toBeInTheDocument();
  });

  it('calls onBack when the back button is clicked', async () => {
    const onBack = vi.fn();
    render(<AccountDetailPage accountId="acc_1" onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
