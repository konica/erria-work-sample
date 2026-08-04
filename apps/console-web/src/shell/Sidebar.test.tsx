import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Sidebar } from './Sidebar.js';

describe('Sidebar', () => {
  it('fetches nav counts and shows them on the Review and Escalations nav items', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ review: 3, escalation: 1 }),
      }),
    );

    render(<Sidebar active="queue" />);

    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders no count badge for a screen whose count is zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ review: 0, escalation: 0 }),
      }),
    );

    render(<Sidebar active="queue" />);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/nav-counts'));
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});
