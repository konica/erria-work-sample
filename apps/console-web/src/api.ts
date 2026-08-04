export interface AccountDetail {
  account: {
    id: string;
    companyName: string;
    segment: string;
    hub: string;
    icpBand: 'high' | 'med' | 'low';
    relationshipSummary: string;
    currentTier: number;
    tierRationale: string;
  };
  vessels: { id: string; name: string; imo: string; flag: string }[];
  contacts: { id: string; name: string; role: string; email: string | null }[];
  pendingMessage: { id: string; body: string; edited: boolean; tierContext: number } | null;
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export const api = {
  getAccount: (accountId: string) => fetch(`/api/accounts/${accountId}`).then(json<AccountDetail>),

  editMessage: (accountId: string, messageId: string, body: string) =>
    fetch(`/api/accounts/${accountId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }).then(json<{ message: { id: string; body: string; edited: boolean } }>),

  approveMessage: (accountId: string, messageId: string) =>
    fetch(`/api/accounts/${accountId}/messages/${messageId}/approve`, { method: 'POST' }).then(
      json<{ message: { id: string; status: string } }>,
    ),

  rejectMessage: (accountId: string, messageId: string) =>
    fetch(`/api/accounts/${accountId}/messages/${messageId}/reject`, { method: 'POST' }).then(
      json<{ message: { id: string; status: string } }>,
    ),
};
