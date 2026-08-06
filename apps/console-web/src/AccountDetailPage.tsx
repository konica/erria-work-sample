import { useEffect, useState } from 'react';
import { Icon, type IconName } from './shell/icons.js';
import { api, escalationApi, type AccountDetail, type EscalationSummary } from './api.js';
import { TierHistorySection } from './TierHistorySection.js';
import { TierBadge } from './TierBadge.js';
import { EscalationPanel } from './EscalationPanel.js';
import { ChangeTierPanel } from './ChangeTierPanel.js';

type Decision = 'approved' | 'rejected' | null;

/** The four tabs from the mockup's `state.detailTab` (`renderDetail()`). Entry always lands on
 * 'work' — the actionable tab — regardless of tier; only its label/icon vary by tier. */
type DetailTab = 'info' | 'work' | 'history' | 'resolution';

/**
 * Mirrors the `HoldReason` values the autonomous-send gate writes to `Message.hardRuleFlags`
 * (packages/domain/src/autonomous/evaluate-autonomous-send.ts) — a held message assumes someone
 * can send it, so it explains which of the five conditions is the reason it is waiting.
 */
const HOLD_EXPLANATIONS: Record<string, string> = {
  autonomous_paused_hold: 'Held for approval — autonomous sending is currently paused.',
  escalation_hold: 'Held for approval — this account has an open escalation.',
  compliance_deadline_content:
    'Held for approval — cites a vessel compliance deadline, which is never sent unreviewed.',
  low_confidence_hold: "Held for approval — the agent's own confidence in this draft was not high.",
};

function holdExplanation(flags: string[]): string {
  return flags.map((flag) => HOLD_EXPLANATIONS[flag] ?? `Held for approval — ${flag}.`).join(' ');
}

export function AccountDetailPage({ accountId, onBack }: { accountId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [decision, setDecision] = useState<Decision>(null);
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState('');
  const [edited, setEdited] = useState(false);
  const [escalation, setEscalation] = useState<EscalationSummary | null>(null);
  const [tierPanelOpen, setTierPanelOpen] = useState(false);
  const [tab, setTab] = useState<DetailTab>('work');

  useEffect(() => {
    // A new account starts back on the actionable tab — the previous account's tab selection
    // doesn't carry over.
    setTab('work');
    api.getAccount(accountId).then((data) => {
      setDetail(data);
      setDraftBody(data.pendingMessage?.body ?? '');
      setEdited(data.pendingMessage?.edited ?? false);
    });
    // No accountId filter on GET /api/escalations — this account's active escalation, if any, is
    // found by matching the small active-escalation list rather than a dedicated endpoint.
    escalationApi.list('active').then((data) => {
      setEscalation(data.items.find((item) => item.accountId === accountId) ?? null);
    });
  }, [accountId]);

  if (!detail) return <p>Loading account…</p>;

  const { account, vessels, contacts, pendingMessage } = detail;
  const primaryVessel = vessels[0];
  const primaryContact = contacts[0];

  async function save() {
    if (!pendingMessage) return;
    const result = await api.editMessage(account.id, pendingMessage.id, draftBody);
    setDraftBody(result.message.body);
    setEdited(result.message.edited);
    setEditing(false);
  }

  async function approve() {
    if (!pendingMessage) return;
    await api.approveMessage(account.id, pendingMessage.id);
    setDecision('approved');
  }

  async function reject() {
    if (!pendingMessage) return;
    await api.rejectMessage(account.id, pendingMessage.id);
    setDecision('rejected');
  }

  // Mirrors the mockup's workLabel/workIcon branching by tier — the account's own icon/label
  // for the actionable tab, not a fixed "Draft review".
  const workLabel = account.currentTier === 3 ? 'Escalation' : account.currentTier === 1 ? 'Activity' : 'Draft review';
  const workIcon: IconName = account.currentTier === 3 ? 'escalation' : account.currentTier === 1 ? 'robot' : 'review';
  const outreachTitle = escalation ? 'Active escalation' : 'Draft awaiting approval';
  const outreachIcon: IconName = escalation ? 'escalation' : 'review';

  return (
    <div>
      <div className="detail-top">
        <button className="back-btn" onClick={onBack}>
          <Icon name="arrow" />
          Back to queue
        </button>
        <div className="detail-hd">
          <h1>{account.companyName}</h1>
          <div className="sub">
            <Icon name="ship" />
            <span>{primaryVessel?.name ?? 'No vessel on file'}</span>
            {primaryContact && (
              <>
                <span>·</span>
                <Icon name="user" />
                <span>
                  {primaryContact.name}, {primaryContact.role}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="detail-tier">
          <TierBadge tier={account.currentTier} />
          <button
            className="tier-change-link"
            onClick={() => setTierPanelOpen(true)}
            data-od-id="change-tier-link"
          >
            <Icon name="pencil" />
            Change tier
          </button>
        </div>
      </div>

      {tierPanelOpen && (
        <ChangeTierPanel
          accountId={account.id}
          currentTier={account.currentTier}
          onChanged={(tier) => {
            setDetail({ ...detail, account: { ...detail.account, currentTier: tier } });
            setTierPanelOpen(false);
          }}
          onCancel={() => setTierPanelOpen(false)}
        />
      )}

      <div className="detail-tabs" data-od-id="detail-tabs">
        <button
          type="button"
          className={`detail-tab ${tab === 'info' ? 'active' : ''}`}
          onClick={() => setTab('info')}
          data-od-id="tab-info"
        >
          <Icon name="building" />
          Account info
        </button>
        <button
          type="button"
          className={`detail-tab ${tab === 'work' ? 'active' : ''}`}
          onClick={() => setTab('work')}
          data-od-id="tab-work"
        >
          <Icon name={workIcon} />
          {workLabel}
        </button>
        <button
          type="button"
          className={`detail-tab ${tab === 'history' ? 'active' : ''}`}
          onClick={() => setTab('history')}
          data-od-id="tab-history"
        >
          <Icon name="audit" />
          Tier history
        </button>
        <button
          type="button"
          className={`detail-tab ${tab === 'resolution' ? 'active' : ''}`}
          onClick={() => setTab('resolution')}
          data-od-id="tab-resolution"
        >
          <Icon name="checkc" />
          Resolution &amp; outcome
        </button>
      </div>

      {tab === 'info' && (
        <div className="detail-panel info-wrap" data-od-id="detail-info">
          <div className="dossier">
            <h3>
              <Icon name="building" />
              Account info
            </h3>

            <div className="doss-card">
              <div className="doss-row">
                <span className="k">Segment</span>
                <span className="v">{account.segment}</span>
              </div>
              <div className="doss-row">
                <span className="k">Hub</span>
                <span className="v">{account.hub}</span>
              </div>
              {vessels.map((vessel) => (
                <div className="doss-row" key={vessel.id}>
                  <span className="k">Vessel</span>
                  <span className="v">
                    {vessel.name} · IMO {vessel.imo} · {vessel.flag}
                  </span>
                </div>
              ))}
            </div>

            {contacts.map((contact) => (
              <div className="doss-card" key={contact.id}>
                <div className="contact-block">
                  <div className="avatar">{contact.name.charAt(0)}</div>
                  <div>
                    <div className="cb-name">{contact.name}</div>
                    <div className="cb-role">{contact.role}</div>
                  </div>
                </div>
              </div>
            ))}

            <div className="doss-card">
              <div className="doss-row">
                <span className="k">Relationship</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                {account.relationshipSummary}
              </div>
            </div>

            <div className="tier-panel">
              <div className="tp-top">
                <span className="lbl">Current tier</span>
                <TierBadge tier={account.currentTier} />
              </div>
              <div className="tp-why">
                <Icon name="info" />
                {account.tierRationale}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'work' && (
        <div className="detail-panel detail-narrow" data-od-id="detail-work">
          <div className="detail-section" data-od-id="detail-outreach">
            <div className="sh">
              <Icon name={outreachIcon} />
              <span className="st">{outreachTitle}</span>
            </div>

            {escalation ? (
              <EscalationPanel escalation={escalation} onResolved={() => {}} />
            ) : !pendingMessage ? (
              <div className="empty">
                <Icon name="review" />
                <div>
                  <b>Nothing awaiting review on this account.</b>
                </div>
              </div>
            ) : (
              <>
                <div className="thread">
                  {editing ? (
                    <div className="msg draft">
                      <div className="m-head">
                        <span className="draft-flag">
                          <Icon name="pencil" />
                          Editing draft
                        </span>
                        <span className="m-when">Agent · ready to send</span>
                      </div>
                      <textarea
                        className="draft-edit"
                        value={draftBody}
                        onChange={(event) => setDraftBody(event.target.value)}
                      />
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button className="btn primary sm" onClick={save}>
                          <Icon name="check" />
                          Save changes
                        </button>
                        <button className="btn sm" onClick={() => setEditing(false)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="msg draft">
                      <div className="m-head">
                        <span className="draft-flag">
                          <Icon name="spark" />
                          Agent draft
                        </span>
                        {decision === null && <span className="m-when">Ready to send</span>}
                      </div>
                      <div className="m-body">{draftBody}</div>
                    </div>
                  )}
                </div>

                {pendingMessage.hardRuleFlags?.length && !editing ? (
                  <div className="policy-tags">
                    <div className="policy-tag">
                      <Icon name="flag" />
                      <span className="pt-body">{holdExplanation(pendingMessage.hardRuleFlags)}</span>
                    </div>
                  </div>
                ) : null}

                {edited && !editing && (
                  <div className="policy-tags">
                    <div className="policy-tag hard">
                      <Icon name="pencil" />
                      <span>
                        <b>Edited by a human.</b>{' '}
                        <span className="pt-body">
                          This send will not count toward the account's clean-approval progress.
                        </span>
                      </span>
                    </div>
                  </div>
                )}

                {!editing && (
                  <div className="policy-tags">
                    <div className="policy-tag info">
                      <Icon name="info" />
                      <span className="pt-body">
                        Approving sends this message as-is from the Erria Outreach mailbox.
                      </span>
                    </div>
                  </div>
                )}

                {decision === 'approved' ? (
                  <div className="decision detail-decision">
                    <div className="decision-done approved">
                      <Icon name="checkc" />
                      Approved · sending
                    </div>
                  </div>
                ) : decision === 'rejected' ? (
                  <div className="decision detail-decision">
                    <div className="decision-done rejected">
                      <Icon name="xc" />
                      Rejected — returned to the agent, not sent
                    </div>
                  </div>
                ) : !editing ? (
                  <div className="decision detail-decision">
                    <div className="d-lead">
                      <Icon name="spark" />
                      Your decision — the agent won't send until you act
                    </div>
                    <button className="btn danger" onClick={reject}>
                      <Icon name="x" />
                      Reject
                    </button>
                    <button className="btn" onClick={() => setEditing(true)}>
                      <Icon name="pencil" />
                      Edit
                    </button>
                    <button className="btn primary" onClick={approve}>
                      <Icon name="check" />
                      Approve &amp; send
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div className="detail-panel" data-od-id="detail-history">
          <TierHistorySection accountId={account.id} />
        </div>
      )}

      {tab === 'resolution' && (
        <div className="detail-panel" data-od-id="detail-resolution">
          <div className="res-empty" data-od-id="resolution-empty">
            <Icon name="info" />
            <span>
              No closed escalations yet for this account. When an escalation here is resolved, its
              action, follow-up, outcome, and time-to-resolution are logged here.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
