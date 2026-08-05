import { useEffect, useState } from 'react';
import { Icon } from './shell/icons.js';
import { auditApi, type AuditSampleRow } from './api.js';

type ReviewStatus = AuditSampleRow['reviewStatus'];
type FilterKey = 'all' | ReviewStatus;

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unreviewed', label: 'Unreviewed' },
  { key: 'fine', label: 'Fine' },
  { key: 'concerning', label: 'Concerning' },
];

function ReviewBadge({ status }: { status: ReviewStatus }) {
  if (status === 'fine') {
    return (
      <span className="badge ok">
        <Icon name="checkc" />
        Fine
      </span>
    );
  }
  if (status === 'concerning') {
    return (
      <span className="badge esc">
        <Icon name="flag" />
        Concerning
      </span>
    );
  }
  return null;
}

export function SendAuditPage() {
  const [rows, setRows] = useState<AuditSampleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function refresh() {
    try {
      const data = await auditApi.list();
      setRows(data.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sampled sends');
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function mark(id: string, verdict: 'fine' | 'concerning') {
    await auditApi.mark(id, verdict);
    await refresh();
  }

  if (error) return <p role="alert">{error}</p>;
  if (!rows) return <p>Loading sampled sends…</p>;

  const counts: Record<FilterKey, number> = {
    all: rows.length,
    unreviewed: rows.filter((row) => row.reviewStatus === 'unreviewed').length,
    fine: rows.filter((row) => row.reviewStatus === 'fine').length,
    concerning: rows.filter((row) => row.reviewStatus === 'concerning').length,
  };
  const visible = filter === 'all' ? rows : rows.filter((row) => row.reviewStatus === filter);

  return (
    <div>
      <p className="divider-note">
        A sample of Tier 1 autonomous sends, pulled for retrospective tone spot-checks. These
        messages have already been sent — reviewing them catches tone drift across many sends
        rather than gating any one of them. Marking a send fine or concerning never changes the
        account&apos;s tier, and a concerning send stays in the list so patterns stay visible over
        time.
      </p>

      {rows.length === 0 ? (
        <div className="empty">
          <Icon name="sample" />
          <div>
            <b>No sampled sends yet.</b> Sampling starts once Tier 1 accounts send autonomously —
            until then this queue stays empty by design, not broken.
          </div>
        </div>
      ) : (
        <>
          <div className="sa-stats">
            <span className="sa-stat">
              <Icon name="sample" /> {counts.all} sampled
            </span>
            <span className="sa-stat ok">
              <Icon name="checkc" /> {counts.fine} fine
            </span>
            <span className="sa-stat warn">
              <Icon name="flag" /> {counts.concerning} concerning
            </span>
            <span className="sa-stat mut">{counts.unreviewed} unreviewed</span>
          </div>

          <div className="filters">
            {FILTERS.map((option) => (
              <button
                key={option.key}
                type="button"
                className={`chip ${filter === option.key ? 'active' : ''}`}
                onClick={() => setFilter(option.key)}
              >
                {option.label} <span className="n">{counts[option.key]}</span>
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <div className="empty">
              <Icon name="sample" />
              <div>No sampled sends match this filter.</div>
            </div>
          ) : (
            <div className="q-table">
              <div className="q-head sa-head">
                <div>Account</div>
                <div>Message</div>
                <div>Tier</div>
                <div>Sent</div>
                <div>Review</div>
              </div>
              {visible.map((row) => {
                const open = expandedId === row.id;
                return (
                  <div
                    className={`sa-rowwrap ${row.reviewStatus === 'concerning' ? 'flagged' : ''}`}
                    key={row.id}
                  >
                    <div className="q-row sa-row">
                      <div className="acct">
                        <div className="co">
                          {row.company}
                          <ReviewBadge status={row.reviewStatus} />
                        </div>
                      </div>
                      <div className="trigger">
                        <div className="tline">{row.body}</div>
                      </div>
                      <div>
                        <span className="badge t1">
                          <Icon name="robot" />
                          Tier 1
                        </span>
                      </div>
                      <div className="time">
                        {row.sentAt ? new Date(row.sentAt).toLocaleString() : '—'}
                      </div>
                      <div className="sa-actions">
                        <button
                          type="button"
                          className={`btn sm ${row.reviewStatus === 'fine' ? 'ok-on' : ''}`}
                          onClick={() => mark(row.id, 'fine')}
                        >
                          <Icon name="check" />
                          Fine
                        </button>
                        <button
                          type="button"
                          className={`btn sm ${row.reviewStatus === 'concerning' ? 'warn-on' : ''}`}
                          onClick={() => mark(row.id, 'concerning')}
                        >
                          <Icon name="flag" />
                          Concerning
                        </button>
                        <button
                          type="button"
                          className="sa-exp"
                          aria-label={open ? 'Collapse sent message' : 'Expand sent message'}
                          onClick={() => setExpandedId(open ? null : row.id)}
                        >
                          <Icon name="chevron" />
                        </button>
                      </div>
                    </div>
                    {open && (
                      <div className="sa-body">
                        <div className="sa-body-label">
                          <Icon name="spark" />
                          Sent message
                        </div>
                        <div className="msg inbound">
                          <div className="m-body">{row.body}</div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
