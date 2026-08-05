import { useEffect, useState } from 'react';
import { Icon } from './shell/icons.js';
import { escalationApi, type EscalationSummary, type OutcomeTag, type PriorResolution } from './api.js';

const RULE_LABELS: Record<string, string> = {
  pricing_question: 'Hard trigger · pricing question',
  technical_compliance_question: 'Hard trigger · technical/compliance question',
  negative_sentiment: 'Hard trigger · negative sentiment',
  relationship_conflict: 'Hard trigger · relationship conflict',
  compliance_deadline_content: 'Hard trigger · compliance deadline',
  non_english_language: 'Hard trigger · non-English language',
  conflicting_signals: 'Hard trigger · conflicting signals',
  classification_uncertain: 'Hard trigger · classification uncertain',
};

function ruleLabel(rule: string): string {
  return RULE_LABELS[rule] ?? `Hard trigger · ${rule.replace(/_/g, ' ')}`;
}

const OUTCOMES: { value: OutcomeTag; label: string }[] = [
  { value: 'closed_won', label: 'Closed-won' },
  { value: 're_engaged', label: 'Re-engaged' },
  { value: 'no_response', label: 'No response' },
  { value: 'churned', label: 'Churned' },
  { value: 'closed_no_action', label: 'Closed · no action' },
];

function priorLabel(prior: PriorResolution): string {
  return `${new Date(prior.resolvedAt).toLocaleDateString()} · ${prior.actionTaken}`;
}

export function EscalationPanel({
  escalation,
  onResolved,
}: {
  escalation: EscalationSummary;
  onResolved: () => void;
}) {
  const [priors, setPriors] = useState<PriorResolution[]>([]);
  const [previewId, setPreviewId] = useState('');
  const [linkedId, setLinkedId] = useState<string | null>(escalation.repeatOfResolutionId);
  const [outcome, setOutcome] = useState<OutcomeTag | ''>('');
  const [actionTaken, setActionTaken] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [error, setError] = useState('');
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    escalationApi.priorResolutions(escalation.accountId).then((data) => setPriors(data.items));
  }, [escalation.accountId]);

  async function resolve(actionType: 'mark_resolved' | 'compose_send') {
    if (!outcome) {
      setError('Choose an outcome before closing this escalation.');
      return;
    }
    if (actionType === 'compose_send' && !replyBody.trim()) {
      setError('Write the reply you want to send.');
      return;
    }
    setError('');
    await escalationApi.resolve(escalation.accountId, escalation.id, {
      actionType,
      // "Marked resolved" mirrors the no-action-needed case — the DTO requires a non-empty action.
      actionTaken: actionTaken.trim() || 'Marked resolved',
      followupBody: actionType === 'compose_send' ? replyBody : undefined,
      outcomeTag: outcome,
    });
    setResolved(true);
    onResolved();
  }

  async function commitLink() {
    if (!previewId) return;
    const result = await escalationApi.link(escalation.accountId, escalation.id, previewId);
    setLinkedId(result.escalation.repeatOfResolutionId);
    setPreviewId('');
  }

  async function unlink() {
    const result = await escalationApi.unlink(escalation.accountId, escalation.id);
    setLinkedId(result.escalation.repeatOfResolutionId);
  }

  const preview = priors.find((prior) => prior.id === previewId);
  const linked = priors.find((prior) => prior.id === linkedId);

  return (
    <div data-od-id="detail-outreach">
      {linkedId && linked ? (
        <div className="repeat-banner" data-od-id="repeat-banner">
          <Icon name="link" />
          <div className="rb-main">
            <div className="rb-kick">Repeat escalation</div>
            <div className="rb-text">
              Related to a prior resolution — <b>{priorLabel(linked)}</b>. Handle as a continuation, not a
              first-time case.
            </div>
          </div>
          <button className="btn sm" onClick={unlink} data-od-id="btn-unlink">
            Unlink
          </button>
        </div>
      ) : priors.length > 0 ? (
        <div className="repeat-link" data-od-id="repeat-link">
          <div className="rl-top">
            <Icon name="link" />
            <span className="rl-title">Is this a repeat of a past issue?</span>
          </div>
          <p className="rl-sub">
            This account has {priors.length} resolved case{priors.length > 1 ? 's' : ''} on record. If
            this escalation continues one of them, link it so it's handled as a continuation — not a
            first-time case.
          </p>
          <div className="rl-row">
            <select
              aria-label="Related to a prior resolution"
              value={previewId}
              onChange={(event) => setPreviewId(event.target.value)}
              data-od-id="repeat-link-select"
            >
              <option value="">Link to a prior resolution…</option>
              {priors.map((prior) => (
                <option key={prior.id} value={prior.id}>
                  {priorLabel(prior)}
                </option>
              ))}
            </select>
            {preview && (
              <button className="btn primary sm" onClick={commitLink} data-od-id="repeat-link-commit">
                <Icon name="link" />
                Link it
              </button>
            )}
          </div>
          {preview && (
            <div className="rl-preview" data-od-id="repeat-link-preview">
              <Icon name="info" />
              <span>
                <b>You&apos;ll see:</b> a "Repeat escalation" banner here, cross-referenced with the linked
                resolution record ({priorLabel(preview)}).
              </span>
            </div>
          )}
        </div>
      ) : null}

      <div className="esc-banner" data-od-id="escalation-banner">
        <div className="eb-icon">
          <Icon name="escalation" />
        </div>
        <div>
          <div className="eb-kick">{ruleLabel(escalation.rule)}</div>
          <div className="eb-reason">{escalation.reasonSummary}</div>
        </div>
        <div className="eb-meta">
          <div>Escalated {new Date(escalation.createdAt).toLocaleString()}</div>
        </div>
      </div>

      <div className="next-step" data-od-id="next-step">
        <div className="ns-head">
          <Icon name="spark" />
          <span className="ns-title">Recommended next step</span>
          <span className="ns-tag badge ghost">Agent-suggested</span>
        </div>
        <div className="ns-body">{escalation.recommendedNextStep}</div>
        <div className="ns-actions">
          <span className="no-send">
            <Icon name="lock" />
            Agent send is disabled for this thread — only you can act
          </span>
        </div>
      </div>

      {resolved ? (
        <div className="esc-actionbar done" data-od-id="escalation-actions">
          <div className="ea-done">
            <Icon name="checkc" />
            Resolved by you — recorded to this account's resolution history
          </div>
        </div>
      ) : (
        <>
          <div className="tp-body">
            <div className="tp-field">
              <span className="tp-label">
                Outcome <em>(required)</em>
              </span>
              <div className="seg" role="group" aria-label="Outcome">
                {OUTCOMES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={outcome === option.value ? 'on' : ''}
                    onClick={() => {
                      setOutcome(option.value);
                      setError('');
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="tp-field">
              <span className="tp-label">Action taken</span>
              <input
                type="text"
                className="tp-reason"
                aria-label="Action taken"
                value={actionTaken}
                onChange={(event) => setActionTaken(event.target.value)}
                placeholder="e.g. Sent an indicative quote by phone"
              />
            </div>
          </div>

          <div className="tp-field">
            <span className="tp-label">Reply to send (only for Compose &amp; send reply)</span>
            <textarea
              className="ns-edit"
              aria-label="Reply to send"
              value={replyBody}
              onChange={(event) => setReplyBody(event.target.value)}
              placeholder="Write a reply to send as a human…"
            />
          </div>

          {error && (
            <p className="tp-err">
              <Icon name="info" />
              {error}
            </p>
          )}

          <div className="esc-actionbar" data-od-id="escalation-actions">
            <div className="ea-lead">
              <Icon name="user" />
              Your move — the human decides what happens next
            </div>
            <button className="btn" onClick={() => resolve('mark_resolved')} data-od-id="btn-mark-resolved">
              <Icon name="check" />
              Mark resolved
            </button>
            <button
              className="btn primary"
              onClick={() => resolve('compose_send')}
              data-od-id="btn-send-reply"
            >
              <Icon name="send" />
              Compose &amp; send reply
            </button>
          </div>
        </>
      )}
    </div>
  );
}
