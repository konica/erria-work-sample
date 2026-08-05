import type { ReactNode } from 'react';
import { Header } from './Header.js';
import { Sidebar } from './Sidebar.js';
import type { ScreenKey } from './screens.js';

/*
 * No router yet — App.tsx tracks the active screen as local state and passes it down here,
 * rather than deriving it from a URL.
 */
export function AppShell({
  active,
  onNavigate,
  children,
}: {
  active: ScreenKey;
  onNavigate?: (screen: ScreenKey) => void;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <Sidebar active={active} onNavigate={onNavigate} />
      <main className="main">
        <Header active={active} />
        <div className="scroll">{children}</div>
      </main>
    </div>
  );
}
