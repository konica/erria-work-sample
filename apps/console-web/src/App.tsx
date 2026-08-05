import { useEffect, useState } from 'react';
import { AppShell } from './shell/AppShell.js';
import { QueuePage } from './QueuePage.js';
import { AccountDetailPage } from './AccountDetailPage.js';
import { AuthGate } from './auth/AuthGate.js';
import { initAuth } from './auth/authStore.js';
import { useAuth } from './auth/useAuth.js';

export function App() {
  const { view } = useAuth();
  const [openAccountId, setOpenAccountId] = useState<string | null>(null);

  useEffect(() => {
    void initAuth();
  }, []);

  // Deliberately render nothing while the very first check (is there already a valid
  // session?) is in flight, rather than flashing the Landing page at an already-logged-in
  // user on refresh.
  if (view === 'loading') return null;

  if (view !== 'authenticated') return <AuthGate />;

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
