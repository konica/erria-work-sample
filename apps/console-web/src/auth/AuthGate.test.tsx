import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { AuthGate } from './AuthGate.js';
import { useAuth } from './useAuth.js';
import type { AuthView } from './authStore.js';

vi.mock('./useAuth.js', () => ({ useAuth: vi.fn() }));

function mockView(view: AuthView) {
  const login = vi.fn();
  const logout = vi.fn();
  (useAuth as Mock).mockReturnValue({ view, user: null, login, logout });
  return { login, logout };
}

describe('AuthGate', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.clear();
  });

  it('renders the Landing state with the orientation copy and a working Log in button', () => {
    const { login } = mockView('landing');
    render(<AuthGate />);

    expect(
      screen.getByText('Internal console for reviewing and sending AI-drafted customer outreach, and handling escalations.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(login).toHaveBeenCalled();
  });

  it('renders the Redirecting state with no login CTA — it is transient and auto-dismissing', () => {
    mockView('redirecting');
    render(<AuthGate />);

    expect(screen.getByText('Redirecting you to sign in…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Log in' })).not.toBeInTheDocument();
  });

  it("renders the Signed-out state as the app's own logout confirmation, with the Log in CTA restored", () => {
    mockView('loggedOut');
    render(<AuthGate />);

    expect(screen.getByText("You've been signed out.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
  });

  it('renders the Session-expired state with an explanation before bouncing back into Keycloak', () => {
    mockView('expired');
    render(<AuthGate />);

    expect(screen.getByText('Your session has expired. Please sign in again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument();
  });

  it('switches all gate copy to Dansk and persists the choice, on any of the four states', () => {
    mockView('expired');
    render(<AuthGate />);

    fireEvent.click(screen.getByRole('button', { name: 'Dansk' }));

    expect(screen.getByText('Din session er udløbet. Log ind igen.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log ind' })).toBeInTheDocument();
    expect(localStorage.getItem('erria-lang')).toBe('da');
  });

  it('defaults to English per the design brief, and still renders the theme toggle', () => {
    mockView('landing');
    render(<AuthGate />);

    expect(screen.getByRole('button', { name: 'EN' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: /Dark|Light/ })).toBeInTheDocument();
  });
});
