import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ThemeToggle } from './ThemeToggle.js';

describe('ThemeToggle', () => {
  beforeEach(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.clear();
  });

  it('renders the moon icon and "Dark" label when the page is light-themed', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button')).toHaveTextContent('Dark');
  });

  it('renders the sun icon and "Light" label when the page is dark-themed', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    render(<ThemeToggle />);
    expect(screen.getByRole('button')).toHaveTextContent('Light');
  });

  it('flips data-theme on the root element and persists the choice on click', () => {
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole('button'));

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem('erria-theme')).toBe('dark');
    expect(screen.getByRole('button')).toHaveTextContent('Light');
  });

  it('flips back to light on a second click', () => {
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button'));

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('erria-theme')).toBe('light');
  });
});
