import { useState } from 'react';
import { AppShell } from './shell/AppShell.js';
import { QueuePage } from './QueuePage.js';
import { AccountDetailPage } from './AccountDetailPage.js';

export function App() {
  const [openAccountId, setOpenAccountId] = useState<string | null>(null);

  return (
    <AppShell>
      {openAccountId ? (
        <AccountDetailPage accountId={openAccountId} onBack={() => setOpenAccountId(null)} />
      ) : (
        <QueuePage onOpenAccount={setOpenAccountId} />
      )}
    </AppShell>
  );
}
