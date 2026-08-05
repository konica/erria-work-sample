import { useState } from 'react';
import { Icon } from './shell/icons.js';
import { TierBadge } from './TierBadge.js';
import { escalationApi } from './api.js';

export function ChangeTierPanel({
  accountId,
  currentTier,
  onChanged,
  onCancel,
}: {
  accountId: string;
  currentTier: number;
  onChanged: (tier: number) => void;
  onCancel: () => void;
}) {
  // Tier 1 is deliberately absent — earned via clean approvals, never set by hand (ADR-0004).
  const choices: (2 | 3)[] = [2, 3];
  const [selected, setSelected] = useState<2 | 3 | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(false);

  async function confirm() {
    if (!selected || !reason.trim()) {
      setError(true);
      return;
    }
    await escalationApi.changeTier(accountId, selected, reason.trim());
    onChanged(selected);
  }

  return (
    <div className="tier-panel-inline" data-od-id="change-tier-panel">
      <div className="tp-hd">
        <Icon name="pencil" />
        <b>Change tier manually</b> — a human override that becomes a permanent Tier History entry,
        separate from any escalation.
      </div>
      <div className="tp-body">
        <div className="tp-field">
          <span className="tp-label">New tier</span>
          <div className="tier-choices">
            {choices.map((tier) => (
              <button
                key={tier}
                type="button"
                className={`tier-choice ${selected === tier ? 'sel' : ''}`}
                onClick={() => {
                  setSelected(tier);
                  setError(false);
                }}
                data-od-id={`tier-choice-${tier}`}
              >
                <TierBadge tier={tier} />
              </button>
            ))}
          </div>
          <span className="tp-note">Tier 1 is earned through clean approvals, never set by hand.</span>
        </div>
        <div className="tp-field">
          <span className="tp-label">
            Reason <em>(required)</em>
          </span>
          <input
            type="text"
            className={`tp-reason ${error ? 'err' : ''}`}
            value={reason}
            placeholder="e.g. Pricing question resolved by AE, no other open issues on this account"
            onChange={(event) => {
              setReason(event.target.value);
              if (event.target.value.trim()) setError(false);
            }}
            data-od-id="tier-reason"
          />
          {error && (
            <span className="tp-err">
              <Icon name="info" />A reason is required — it's saved to Tier History.
            </span>
          )}
        </div>
      </div>
      <div className="tp-actions">
        <button className="btn primary sm" onClick={confirm} data-od-id="confirm-tier">
          <Icon name="check" />
          Confirm change
        </button>
        <button className="btn sm" onClick={onCancel} data-od-id="cancel-tier">
          Cancel
        </button>
        <span className="tp-note">
          Currently <b>Tier {currentTier}</b> → <b>Tier {selected ?? currentTier}</b>. Nothing changes
          until you confirm.
        </span>
      </div>
    </div>
  );
}
