import { Icon } from './icons.js';

/*
 * Static for this ticket — always renders the mockup's default light-theme state
 * (moon icon, "Dark" label). Wiring an actual click handler and persisted/OS-preference
 * theme state is ticket #45.
 */
export function ThemeToggle() {
  return (
    <button type="button" className="theme-toggle">
      <Icon name="moon" />
      Dark
    </button>
  );
}
