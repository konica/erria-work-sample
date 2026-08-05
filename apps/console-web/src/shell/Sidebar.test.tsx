import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Sidebar } from './Sidebar.js';

function stubFetch({
  counts = { review: 0, escalation: 0 },
  roles = ['reviewer'],
}: {
  counts?: { review: number; escalation: number };
  roles?: string[];
} = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/nav-counts') {
        return Promise.resolve({ ok: true, json: async () => counts });
      }
      if (url === '/api/me') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ sub: 'user-1', name: 'Test User', roles }),
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

describe('Sidebar', () => {
  it('fetches nav counts and shows them on the Review and Escalations nav items', async () => {
    stubFetch({ counts: { review: 3, escalation: 1 } });

    render(<Sidebar active="queue" />);

    await waitFor(() => expect(screen.getByText('3')).toBeInTheDocument());
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('renders no count badge for a screen whose count is zero', async () => {
    stubFetch({ counts: { review: 0, escalation: 0 } });

    render(<Sidebar active="queue" />);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/nav-counts'));
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('does not show the Settings nav item for a reviewer-only user', async () => {
    stubFetch({ roles: ['reviewer'] });

    render(<Sidebar active="queue" />);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/me'));
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });

  it('shows the Settings nav item for an admin user', async () => {
    stubFetch({ roles: ['admin'] });

    render(<Sidebar active="queue" />);

    await waitFor(() => expect(screen.getByText('Settings')).toBeInTheDocument());
  });

  it('does not show the Settings nav item before the current user has loaded', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    render(<Sidebar active="queue" />);

    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });
});
