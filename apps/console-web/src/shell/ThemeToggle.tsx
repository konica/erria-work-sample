import { useState } from 'react';
import { Icon } from './icons.js';
import { THEME_STORAGE_KEY, type Theme } from './theme-bootstrap.js';

function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // localStorage unavailable (e.g. private browsing) — theme still applies for this session
    }
    setTheme(next);
  }

  const dark = theme === 'dark';
  return (
    <button type="button" className="theme-toggle" onClick={toggle}>
      <Icon name={dark ? 'sun' : 'moon'} />
      {dark ? 'Light' : 'Dark'}
    </button>
  );
}
