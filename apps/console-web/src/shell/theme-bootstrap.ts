export type Theme = 'light' | 'dark';

// Canonical key/logic for resolving the initial theme. `index.html`'s inline bootstrap
// script duplicates this exact logic (it can't import a module and still run
// synchronously before first paint), and `ThemeToggle` imports `THEME_STORAGE_KEY` to
// persist the operator's explicit choice. Keep all three in sync if this changes.
export const THEME_STORAGE_KEY = 'erria-theme';

export function resolveInitialTheme(stored: string | null, prefersDark: boolean): Theme {
  if (stored === 'dark' || stored === 'light') return stored;
  return prefersDark ? 'dark' : 'light';
}
