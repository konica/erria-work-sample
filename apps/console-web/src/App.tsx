import { useState } from 'react';
import { AppShell } from './shell/AppShell.js';
import type { ScreenKey } from './shell/screens.js';
import { QueuePage } from './QueuePage.js';
import { AccountDetailPage } from './AccountDetailPage.js';
import { SendAuditPage } from './SendAuditPage.js';

export function App() {
  const [screen, setScreen] = useState<ScreenKey>('queue');
  const [openAccountId, setOpenAccountId] = useState<string | null>(null);

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
