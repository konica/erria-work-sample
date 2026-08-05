import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from './App.js';

function emptyList() {
  return { ok: true, json: async () => ({ items: [], total: 0, page: 1, pageSize: 20 }) };
}

describe('App navigation', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/nav-counts') {
          return { ok: true, json: async () => ({ review: 0, escalation: 0 }) };
        }
        return emptyList();
      }),
    );
  });

  it('shows the queue table by default', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Account / Vessel')).toBeInTheDocument());
  });

  it('navigates to the Send Audit screen when its nav item is clicked', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Account / Vessel')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /send audit/i }));

    await waitFor(() => expect(screen.getByText(/no sampled sends yet/i)).toBeInTheDocument());
    expect(screen.queryByText('Account / Vessel')).not.toBeInTheDocument();
  });

  it('returns to the queue when its nav item is clicked again', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText('Account / Vessel')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /send audit/i }));
    await waitFor(() => expect(screen.getByText(/no sampled sends yet/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /account queue/i }));

    await waitFor(() => expect(screen.getByText('Account / Vessel')).toBeInTheDocument());
    expect(screen.queryByText(/no sampled sends yet/i)).not.toBeInTheDocument();
  });
});
