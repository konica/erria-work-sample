import { describe, it, expect } from 'vitest';
import { resolveInitialTheme } from './theme-bootstrap.js';

describe('resolveInitialTheme', () => {
  it('uses the stored theme when present, regardless of OS preference', () => {
    expect(resolveInitialTheme('dark', false)).toBe('dark');
    expect(resolveInitialTheme('light', true)).toBe('light');
  });

  it('falls back to the OS preference when nothing is stored', () => {
    expect(resolveInitialTheme(null, true)).toBe('dark');
    expect(resolveInitialTheme(null, false)).toBe('light');
  });

  it('falls back to the OS preference when the stored value is not a valid theme', () => {
    expect(resolveInitialTheme('sepia', true)).toBe('dark');
    expect(resolveInitialTheme('sepia', false)).toBe('light');
  });
});
