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

export interface TierHistoryItem {
  id: string;
  eventType: string;
  fromTier: number | null;
  toTier: number | null;
  reason: string;
  occurredAt: string;
  isManual: boolean;
}

export interface SettingsPayload {
  basic: { tier1PromotionThreshold: number; tier1AuditSampleRate: number };
  advanced: {
    maxFollowups: number;
    minDaysBetweenFollowups: number;
    sentimentConfidenceFloor: 'Low' | 'Medium' | 'High';
  };
  locked: {
    hardTriggerRules: { key: string; label: string; description: string }[];
    rolloutOverlayEnabled: boolean;
    rolloutOverlayDescription: string;
  };
}

export interface AdvancedSettingsProposal {
  requiresConfirmation: boolean;
  diff: { field: string; from: string | number; to: string | number }[];
  notice: string;
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

  getSettings: () => apiFetch('/api/settings').then(json<SettingsPayload>),

  saveBasicSettings: (basic: SettingsPayload['basic']) =>
    apiFetch('/api/settings/basic', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(basic),
    }).then(json<SettingsPayload>),

  proposeAdvancedSettings: (advanced: SettingsPayload['advanced']) =>
    apiFetch('/api/settings/advanced', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(advanced),
    }).then(json<AdvancedSettingsProposal>),

  confirmAdvancedSettings: (advanced: SettingsPayload['advanced']) =>
    apiFetch('/api/settings/advanced/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(advanced),
    }).then(json<SettingsPayload>),
};

export const tierHistoryApi = {
  list: (accountId: string) =>
    apiFetch(`/api/accounts/${accountId}/tier-history`).then(json<{ items: TierHistoryItem[] }>),
};

export interface AuditSampleRow {
  id: string;
  accountId: string;
  company: string;
  body: string;
  sentAt: string | null;
  sampledAt: string;
  reviewStatus: 'unreviewed' | 'fine' | 'concerning';
  reviewedBy: string | null;
}

interface AuditSampleList {
  items: AuditSampleRow[];
  total: number;
  page: number;
  pageSize: number;
}

export const auditApi = {
  list: (status?: 'unreviewed' | 'fine' | 'concerning') =>
    apiFetch(status ? `/api/audit-samples?status=${status}` : '/api/audit-samples').then(
      json<AuditSampleList>,
    ),

  mark: (id: string, verdict: 'fine' | 'concerning') =>
    apiFetch(`/api/audit-samples/${id}/mark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict }),
    }).then(json<{ auditSample: { id: string; reviewStatus: string } }>),
};
