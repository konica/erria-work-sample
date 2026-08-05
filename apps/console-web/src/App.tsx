import { useEffect, useState } from 'react';
import { AppShell } from './shell/AppShell.js';
import type { ScreenKey } from './shell/screens.js';
import { QueuePage } from './QueuePage.js';
import { AccountDetailPage } from './AccountDetailPage.js';
import { SendAuditPage } from './SendAuditPage.js';
import { AuthGate } from './auth/AuthGate.js';
import { initAuth } from './auth/authStore.js';
import { useAuth } from './auth/useAuth.js';

export function App() {
  const { view } = useAuth();
  const [screen, setScreen] = useState<ScreenKey>('queue');
  const [openAccountId, setOpenAccountId] = useState<string | null>(null);

  useEffect(() => {
    void initAuth();
  }, []);

  // Deliberately render nothing while the very first check (is there already a valid
  // session?) is in flight, rather than flashing the Landing page at an already-logged-in
  // user on refresh.
  if (view === 'loading') return null;

  if (view !== 'authenticated') return <AuthGate />;

  function navigate(next: ScreenKey) {
    setScreen(next);
    setOpenAccountId(null);
  }

  let content;
  if (screen === 'queue' && openAccountId) {
    content = <AccountDetailPage accountId={openAccountId} onBack={() => setOpenAccountId(null)} />;
  } else if (screen === 'sendaudit') {
    content = <SendAuditPage />;
  } else {
    content = <QueuePage onOpenAccount={setOpenAccountId} />;
  }

  return (
    <AppShell active={screen} onNavigate={navigate}>
      {content}
    </AppShell>
  );
}
