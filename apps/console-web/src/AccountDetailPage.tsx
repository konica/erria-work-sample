import { useEffect, useState } from 'react';
import { Icon } from './shell/icons.js';
import { api, type AccountDetail } from './api.js';

type Decision = 'approved' | 'rejected' | null;

function TierBadge({ tier }: { tier: number }) {
  if (tier === 1) {
    return (
      <span className="badge t1">
        <Icon name="robot" />
        Tier 1 · Autonomous
      </span>
    );
  }
  if (tier === 3) {
    return (
      <span className="badge t3">
        <Icon name="escalation" />
        Tier 3 · Escalated
      </span>
    );
  }
  return (
    <span className="badge t2">
      <Icon name="pencil" />
      Tier 2 · Needs approval
    </span>
  );
}

export function AccountDetailPage({ accountId, onBack }: { accountId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [decision, setDecision] = useState<Decision>(null);
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState('');
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    api.getAccount(accountId).then((data) => {
      setDetail(data);
      setDraftBody(data.pendingMessage?.body ?? '');
      setEdited(data.pendingMessage?.edited ?? false);
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
        </div>
      </div>

      <div className="detail-grid">
        <div className="detail-col">
          <div className="detail-section">
            <div className="sh">
              <Icon name="review" />
              <span className="st">Draft awaiting approval</span>
            </div>

            {!pendingMessage ? (
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

        <aside className="detail-rail">
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
        </aside>
      </div>
    </div>
  );
}
