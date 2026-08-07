import { useEffect, useState } from 'react';
import { Icon } from './shell/icons.js';
import { escalationApi, type PriorResolution } from './api.js';

/** Maps `Resolution.outcomeTag` to the mockup's `OUTCOMES` badge class/label
 * (outreach-console.html `OUTCOMES`) — `closed_no_action` intentionally shares the neutral
 * `noresp` styling rather than getting its own color. */
const OUTCOME_META: Record<string, { cls: string; label: string }> = {
  closed_won: { cls: 'win', label: 'Closed-won' },
  re_engaged: { cls: 'reeng', label: 'Re-engaged' },
  no_response: { cls: 'noresp', label: 'No response' },
  churned: { cls: 'churn', label: 'Churned' },
  closed_no_action: { cls: 'noresp', label: 'Closed · no action' },
};

function outcomeBadge(outcomeTag: string) {
  const meta = OUTCOME_META[outcomeTag] ?? { cls: 'noresp', label: outcomeTag };
  return <span className={`badge ${meta.cls}`}>{meta.label}</span>;
}

export function ResolutionSection({ accountId }: { accountId: string }) {
  const [items, setItems] = useState<PriorResolution[] | null>(null);

  useEffect(() => {
    escalationApi.priorResolutions(accountId).then((data) => setItems(data.items));
  }, [accountId]);

  return (
    <>
      <p className="divider-note" style={{ marginTop: 0 }}>
        One record per closed escalation — the human action, the follow-up sent, its outcome, and
        time-to-resolution. Closing an active escalation logs a record here.
      </p>

      {!items ? (
        <p>Loading resolution history…</p>
      ) : items.length === 0 ? (
        <div className="res-empty" data-od-id="resolution-empty">
          <Icon name="info" />
          <span>
            No closed escalations yet for this account. When an escalation here is resolved, its
            action, follow-up, outcome, and time-to-resolution are logged here.
          </span>
        </div>
      ) : (
        items.map((item) => (
          <div className="res-row" data-od-id="resolution-row" key={item.id}>
            <div>
              <div className="rk">Human action</div>
              <div className="rv">{item.actionTaken}</div>
            </div>
            <div>
              <div className="rk">Follow-up sent</div>
              <div className="rv mut">
                {item.followupSentAt ? 'Yes' : 'No'}
                {item.followupSentAt && (
                  <span className="rt">{new Date(item.followupSentAt).toLocaleString()}</span>
                )}
              </div>
            </div>
            <div>
              <div className="rk">Outcome</div>
              <div className="rv">{outcomeBadge(item.outcomeTag)}</div>
            </div>
            <div>
              <div className="rk">Time to resolve</div>
              <div className="rv mut">{item.timeToResolution}</div>
            </div>
          </div>
        ))
      )}
    </>
  );
}
