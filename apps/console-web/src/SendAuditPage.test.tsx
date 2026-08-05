import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SendAuditPage } from './SendAuditPage.js';

const sample = {
  id: 'aud_1',
  accountId: 'acc_1',
  company: 'Audited Co',
  body: 'Autonomously sent copy under review.',
  sentAt: '2026-08-01T00:00:00.000Z',
  sampledAt: '2026-08-01T00:00:00.000Z',
  reviewStatus: 'unreviewed' as const,
  reviewedBy: null,
};

describe('SendAuditPage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return {
            ok: true,
            json: async () => ({ auditSample: { id: 'aud_1', reviewStatus: 'concerning' } }),
          };
        }
        return { ok: true, json: async () => ({ items: [sample], total: 1, page: 1, pageSize: 20 }) };
      }),
    );
  });

  it('renders a sampled send with its copy', async () => {
    render(<SendAuditPage />);

    await waitFor(() => expect(screen.getByText('Audited Co')).toBeInTheDocument());
    expect(screen.getByText(/autonomously sent copy/i)).toBeInTheDocument();
  });

  it('renders the row inside the styled q-table grid, reusing the mockup classes', async () => {
    render(<SendAuditPage />);
    await waitFor(() => expect(screen.getByText('Audited Co')).toBeInTheDocument());

    expect(document.querySelector('.q-table')).toBeInTheDocument();
    expect(document.querySelector('.q-head.sa-head')).toBeInTheDocument();
    expect(screen.getByText('Audited Co').closest('.sa-row')).toBeInTheDocument();
    expect(screen.getByText('Tier 1').closest('span')).toHaveClass('badge', 't1');
  });

  it('states that review is retrospective and does not gate sending', async () => {
    render(<SendAuditPage />);

    await waitFor(() => expect(screen.getByText(/already been sent/i)).toBeInTheDocument());
  });

  it('marks a sample concerning', async () => {
    render(<SendAuditPage />);
    await waitFor(() => expect(screen.getByText('Audited Co')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^Concerning$/i }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/audit-samples/aud_1/mark',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('keeps a concerning sample visible when filtered to concerning', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [{ ...sample, reviewStatus: 'concerning' as const }],
          total: 1,
          page: 1,
          pageSize: 20,
        }),
      }),
    );

    render(<SendAuditPage />);
    await waitFor(() => expect(screen.getByText('Audited Co')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^Concerning\b.*1$/i }));

    expect(screen.getByText('Audited Co')).toBeInTheDocument();
    expect(screen.getAllByText('Concerning').length).toBeGreaterThan(0);
  });

  it('allows a verdict to be corrected by clicking the other verdict', async () => {
    render(<SendAuditPage />);
    await waitFor(() => expect(screen.getByText('Audited Co')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /^Fine$/i }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/audit-samples/aud_1/mark',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ verdict: 'fine' }) }),
      ),
    );
  });

  it('explains the empty state rather than looking broken', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }),
      }),
    );

    render(<SendAuditPage />);

    await waitFor(() => expect(screen.getByText(/no sampled sends yet/i)).toBeInTheDocument());
  });
});
