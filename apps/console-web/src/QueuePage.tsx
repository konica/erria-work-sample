import { useEffect, useState } from 'react';

interface QueueRow {
  accountId: string;
  company: string;
  vessel: string | null;
  contact: string | null;
  triggerSummary: string | null;
  icpBand: 'high' | 'med' | 'low';
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

export function QueuePage() {
  const [data, setData] = useState<QueueResponse | null>(null);

  useEffect(() => {
    fetch('/api/queue')
      .then((response) => response.json())
      .then((body: QueueResponse) => setData(body));
  }, []);

  if (!data) return <p>Loading queue…</p>;

  return (
    <table className="queue-table">
      <thead>
        <tr>
          <th>Company</th>
          <th>Vessel</th>
          <th>Trigger</th>
          <th>Tier</th>
        </tr>
      </thead>
      <tbody>
        {data.items.map((row) => (
          <tr key={row.accountId}>
            <td>{row.company}</td>
            <td>{row.vessel ?? '—'}</td>
            <td>{row.triggerSummary ?? '—'}</td>
            <td>
              <span className={`badge t${row.tier}`}>Tier {row.tier}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
