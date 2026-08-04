import type { ReactNode } from 'react';
import { Header } from './Header.js';
import { Sidebar } from './Sidebar.js';
import type { ScreenKey } from './screens.js';

/*
 * No router yet — the only screen the app can show today is the queue, so the active nav
 * item and header crumb/title are fixed here rather than derived.
 */
const ACTIVE_SCREEN: ScreenKey = 'queue';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <Sidebar active={ACTIVE_SCREEN} />
      <main className="main">
        <Header active={ACTIVE_SCREEN} />
        <div className="scroll">{children}</div>
      </main>
    </div>
  );
}
