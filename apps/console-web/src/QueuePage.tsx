import { useEffect, useState } from 'react';
import { Icon } from './shell/icons.js';
import { apiFetch } from './api.js';
import { IcpMeter, type IcpBand } from './IcpMeter.js';

interface QueueRow {
  accountId: string;
  company: string;
  vessel: string | null;
  contact: string | null;
  triggerSummary: string | null;
  icpBand: IcpBand;
  tier: number;
  tierWhy: string;
  lastActionAt: string;
}

interface QueueResponse {
  items: QueueRow[];
  total: number;
  page: number;
  pageSize: number;
}

function rowAccentFor(tier: number) {
  return tier === 3 ? 'esc' : tier === 2 ? 'needs' : 'calm';
}

export function QueuePage({ onOpenAccount }: { onOpenAccount: (accountId: string) => void }) {
  const [data, setData] = useState<QueueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/api/queue')
      .then((response) => {
        if (!response.ok) throw new Error(`GET /api/queue failed: ${response.status}`);
        return response.json();
      })
      .then((body: QueueResponse) => setData(body))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load queue'));
  }, []);

  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p>Loading queue…</p>;

  return (
    <div className="q-table">
      <div className="q-head">
        <div>Account / Vessel</div>
        <div>Trigger</div>
        <div className="col-icp">ICP fit</div>
        <div>Tier &amp; why</div>
        <div>Last action</div>
      </div>
      {data.items.map((row) => (
        <div
          className={`q-row ${rowAccentFor(row.tier)}`}
          key={row.accountId}
          role="button"
          tabIndex={0}
          onClick={() => onOpenAccount(row.accountId)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpenAccount(row.accountId);
            }
          }}
        >
          <div className="acct">
            <div className="co">{row.company}</div>
            <div className="vessel">
              <Icon name="ship" />
              {[row.vessel, row.contact].filter(Boolean).join(' · ') || '—'}
            </div>
          </div>
          <div className="trigger">
            <div className="tline">{row.triggerSummary ?? '—'}</div>
          </div>
          <div className="icp-col">
            <IcpMeter band={row.icpBand} />
          </div>
          <div className="tier-cell">
            <span className={`badge t${row.tier}`}>Tier {row.tier}</span>
            <span className="why">
              <Icon name="info" />
              <span>{row.tierWhy}</span>
            </span>
          </div>
          <div className="rowcta">
            <span className="time">{new Date(row.lastActionAt).toLocaleString()}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
