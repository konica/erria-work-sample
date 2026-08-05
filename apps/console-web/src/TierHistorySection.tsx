import { useEffect, useState } from 'react';
import { Icon } from './shell/icons.js';
import { tierHistoryApi, type TierHistoryItem } from './api.js';

/** CSS hook for the timeline dot color (outreach-console.html's `.tl-item.{kind}` rules). Event
 * types with no dedicated rule fall back to the neutral default dot — still correct, just plain. */
function kindFor(item: TierHistoryItem): string {
  if (item.isManual) return 'manual';
  switch (item.eventType) {
    case 'create':
      return 'create';
    case 'promote':
      return 'promote';
    case 'demote':
    case 'escalate':
      return 'demote';
    case 'current_draft':
      return 'current';
    default:
      return '';
  }
}

/** Every TierHistoryEventType the API can send, exhaustively — a raw enum value never reaches the
 * screen, and a new enum member fails typecheck here instead of silently rendering itself. */
function labelFor(item: TierHistoryItem): string {
  const { toTier } = item;
  switch (item.eventType) {
    case 'create':
      return 'Account created';
    case 'clean_approval':
      return 'Clean approval recorded';
    case 'promote':
      return `Promoted to Tier ${toTier}`;
    case 'demote':
      return `Demoted to Tier ${toTier}`;
    case 'escalate':
      return `Escalated to Tier ${toTier}`;
    case 'hold_at_tier':
      return `Held at Tier ${toTier}`;
    case 'current_draft':
      return 'Current draft capped';
    case 'manual_override':
      return `Manually changed to Tier ${toTier}`;
    default:
      return item.eventType;
  }
}

export function TierHistorySection({ accountId }: { accountId: string }) {
  const [items, setItems] = useState<TierHistoryItem[] | null>(null);

  useEffect(() => {
    tierHistoryApi.list(accountId).then((data) => setItems(data.items));
  }, [accountId]);

  return (
    <div className="detail-section" data-od-id="detail-history">
      <div className="sh">
        <Icon name="audit" />
        <span className="st">Tier history</span>
      </div>

      {!items ? (
        <p>Loading history…</p>
      ) : items.length === 0 ? (
        <div className="empty">
          <Icon name="audit" />
          <div>
            <b>No tier changes recorded for this account yet.</b>
          </div>
        </div>
      ) : (
        <>
          <p className="divider-note">
            Every tier is earned or justified — this log shows why this account sits where it does.{' '}
            <b>Manual</b>-tagged entries are human overrides; the rest are system-driven.
          </p>
          <div className="audit-card" data-od-id="audit-timeline">
            <div className="timeline">
              {items.map((item) => (
                <div className={`tl-item ${kindFor(item)}`.trim()} key={item.id}>
                  <div className="tl-when">{new Date(item.occurredAt).toLocaleString()}</div>
                  <div className="tl-title">
                    <span className="tt">{labelFor(item)}</span>
                    {item.isManual && (
                      <span className="tl-manual" data-od-id="manual-tag">
                        <Icon name="user" />
                        Manual
                      </span>
                    )}
                  </div>
                  <div className="tl-reason">{item.reason}</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
