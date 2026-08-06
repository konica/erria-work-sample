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
  pendingMessage: { id: 'msg_1', body: 'Hi Ms. Pham, ...', edited: false, tierContext: 2, hardRuleFlags: null },
};

function mockFetch(overrides: Record<string, unknown> = {}, activeEscalations: unknown[] = []) {
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
    if (url.startsWith('/api/escalations')) {
      return { ok: true, json: async () => ({ items: activeEscalations }) };
    }
    if (url.includes('/resolutions')) {
      return { ok: true, json: async () => ({ items: [] }) };
    }
    return { ok: true, json: async () => ({ ...detail, ...overrides }) };
  });
}

describe('AccountDetailPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch());
  });

  it('renders the pending draft on the default work tab', async () => {
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());
    expect(screen.getByText(/Hi Ms\. Pham/)).toBeInTheDocument();
  });

  it('renders inside the mockup detail-tabs, not the old two-column grid', async () => {
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());

    expect(document.querySelector('.detail-top')).toBeInTheDocument();
    expect(document.querySelector('.detail-tabs')).toBeInTheDocument();
    expect(document.querySelector('.detail-grid')).not.toBeInTheDocument();
    expect(document.querySelector('.msg.draft')).toBeInTheDocument();
  });

  it('defaults to the work tab and switches tabs on click', async () => {
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: /draft review/i })).toHaveClass('active');
    expect(document.querySelector('.dossier')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /account info/i }));
    expect(screen.getByText('MV Song Hong Pioneer')).toBeInTheDocument();
    expect(screen.queryByText(/Hi Ms\. Pham/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /tier history/i }));
    expect(document.querySelector('[data-od-id="detail-history"]')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /resolution.*outcome/i }));
    expect(screen.getByText(/no closed escalations yet/i)).toBeInTheDocument();
  });

  it('labels the work tab by tier and resets to it when switching accounts', async () => {
    const { rerender } = render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /draft review/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /account info/i }));
    expect(screen.getByRole('button', { name: /account info/i })).toHaveClass('active');

    vi.stubGlobal(
      'fetch',
      mockFetch({
        account: { ...detail.account, id: 'acc_2', companyName: 'Other Co', currentTier: 3 },
      }),
    );
    rerender(<AccountDetailPage accountId="acc_2" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText('Other Co')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /^escalation$/i })).toHaveClass('active');
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

  it('explains in plain language which condition held an autonomous message for approval', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        pendingMessage: {
          id: 'msg_1',
          body: 'Hi Ms. Pham, ...',
          edited: false,
          tierContext: 2,
          hardRuleFlags: ['autonomous_paused_hold'],
        },
      }),
    );

    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Hi Ms\. Pham/)).toBeInTheDocument());
    expect(screen.getByText(/autonomous sending is currently paused/i)).toBeInTheDocument();
  });

  it('shows no hold explanation when nothing held the message', async () => {
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText(/Hi Ms\. Pham/)).toBeInTheDocument());
    expect(screen.queryByText(/held for approval/i)).not.toBeInTheDocument();
  });

  it('shows no review controls when there is no pending draft', async () => {
    vi.stubGlobal('fetch', mockFetch({ pendingMessage: null }));
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.getByText(/nothing awaiting review/i)).toBeInTheDocument();
  });

  it('renders the escalation panel instead of draft review when an escalation is active', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({}, [
        {
          id: 'esc_1',
          accountId: 'acc_1',
          company: 'Song Hong Shipping',
          rule: 'pricing_question',
          reasonSummary: 'Buyer asked about pricing or commercial terms',
          recommendedNextStep: 'Hand to an AE for an indicative quote.',
          status: 'active',
          repeatOfResolutionId: null,
          createdAt: '2026-08-01T00:00:00.000Z',
        },
      ]),
    );

    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);

    await waitFor(() => expect(screen.getByText('Active escalation')).toBeInTheDocument());
    expect(screen.getByText(/buyer asked about pricing/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  });

  it('opens the change-tier panel from the tier badge row', async () => {
    render(<AccountDetailPage accountId="acc_1" onBack={() => {}} />);
    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /change tier/i }));

    expect(screen.getByText(/change tier manually/i)).toBeInTheDocument();
  });

  it('calls onBack when the back button is clicked', async () => {
    const onBack = vi.fn();
    render(<AccountDetailPage accountId="acc_1" onBack={onBack} />);
    await waitFor(() => expect(screen.getByText('Song Hong Shipping')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
