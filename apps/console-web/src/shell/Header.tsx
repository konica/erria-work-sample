import { ThemeToggle } from './ThemeToggle.js';
import { SCREENS, type ScreenKey } from './screens.js';

export function Header({ active }: { active: ScreenKey }) {
  const screen = SCREENS[active];
  return (
    <div className="topbar">
      <div>
        <div className="crumb">
          <b>Erria Outreach</b> · {screen.crumb}
        </div>
        <div className="page-title">{screen.title}</div>
      </div>
      <div className="spacer" />
      <div className="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <circle cx={11} cy={11} r={7} />
          <path d="m21 21-4-4" />
        </svg>
        <input placeholder="Search accounts, vessels…" aria-label="Search" />
      </div>
      <ThemeToggle />
    </div>
  );
}
