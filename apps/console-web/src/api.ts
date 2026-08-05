import { getAccessToken, reportUnauthorized } from './auth/authStore.js';

/**
 * Every console-api call goes through this — it attaches the access token when one exists
 * (acceptance criterion: "every console-api request from console-web carries a valid access
 * token") and flags the session as expired on a 401, which console-api will start returning
 * once #77 wires up its token-validating guard.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getAccessToken();
  const response =
    token === null
      ? await (init === undefined ? fetch(path) : fetch(path, init))
      : await fetch(path, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } });
  if (response.status === 401) reportUnauthorized();
  return response;
}

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
  getAccount: (accountId: string) => apiFetch(`/api/accounts/${accountId}`).then(json<AccountDetail>),

  editMessage: (accountId: string, messageId: string, body: string) =>
    apiFetch(`/api/accounts/${accountId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }).then(json<{ message: { id: string; body: string; edited: boolean } }>),

  approveMessage: (accountId: string, messageId: string) =>
    apiFetch(`/api/accounts/${accountId}/messages/${messageId}/approve`, { method: 'POST' }).then(
      json<{ message: { id: string; status: string } }>,
    ),

  rejectMessage: (accountId: string, messageId: string) =>
    apiFetch(`/api/accounts/${accountId}/messages/${messageId}/reject`, { method: 'POST' }).then(
      json<{ message: { id: string; status: string } }>,
    ),
};
