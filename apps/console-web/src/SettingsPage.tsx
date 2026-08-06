import { useEffect, useState } from 'react';
import { Icon } from './shell/icons.js';
import { api, type AdvancedSettingsProposal, type SettingsPayload } from './api.js';

const SENTIMENT_LEVELS: SettingsPayload['advanced']['sentimentConfidenceFloor'][] = ['Low', 'Medium', 'High'];

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [basic, setBasic] = useState<SettingsPayload['basic'] | null>(null);
  const [advanced, setAdvanced] = useState<SettingsPayload['advanced'] | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [proposal, setProposal] = useState<AdvancedSettingsProposal | null>(null);
  const [pauseReason, setPauseReason] = useState('');
  const [pauseError, setPauseError] = useState(false);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then((data) => {
      setSettings(data);
      setBasic(data.basic);
      setAdvanced(data.advanced);
    });
  }, []);

  if (!settings || !basic || !advanced) return <p>Loading settings…</p>;

  async function pauseAutonomous() {
    if (!pauseReason.trim()) {
      setPauseError(true);
      return;
    }
    const result = await api.pauseAutonomous(pauseReason.trim());
    setSettings(result);
    setPauseReason('');
  }

  async function proposeResume() {
    const proposal = await api.proposeResumeAutonomous();
    setResumeNotice(proposal.notice);
  }

  async function confirmResume() {
    const result = await api.confirmResumeAutonomous();
    setSettings(result);
    setResumeNotice(null);
  }

  return (
    <div className="settings-wrap">
      <section className="set-sec">
        <div className="set-head">
          <span className="set-badge">
            <Icon name="robot" />
            Autonomous sending
          </span>
          <span className="set-sub">
            {settings.autonomous.enabled
              ? 'Tier 1 accounts are sending without a human reading each message first'
              : 'Paused — Tier 1 accounts keep their earned tier; their messages queue for approval'}
          </span>
        </div>

        {settings.autonomous.enabled ? (
          <>
            <p className="divider-note">
              Pausing takes effect immediately, with no confirmation step, and also stops any
              autonomous message already in flight.
            </p>
            <div className="tp-field">
              <span className="tp-label">
                Why are you pausing? <em>(required)</em>
              </span>
              <input
                type="text"
                className={`tp-reason ${pauseError ? 'err' : ''}`}
                value={pauseReason}
                placeholder="e.g. Tone drift spotted on three sends"
                aria-label="Why are you pausing?"
                onChange={(event) => {
                  setPauseReason(event.target.value);
                  if (event.target.value.trim()) setPauseError(false);
                }}
              />
              {pauseError && (
                <span className="tp-err">
                  <Icon name="info" />A reason is required — whoever finds the system paused should
                  be able to see why without asking.
                </span>
              )}
            </div>
            <div className="set-save">
              <button className="btn danger sm" onClick={pauseAutonomous}>
                <Icon name="x" />
                Pause autonomous sending
              </button>
            </div>
          </>
        ) : (
          <>
            <span className="badge esc">
              <Icon name="flag" />
              Paused
            </span>
            {settings.autonomous.pauseReason && (
              <p className="divider-note">Reason: {settings.autonomous.pauseReason}</p>
            )}
            {resumeNotice ? (
              <div className="confirm-inline" data-testid="confirm-resume-autonomous">
                <div className="ci-head">
                  <Icon name="info" />
                  Confirm before resuming
                </div>
                <div className="ci-note">{resumeNotice}</div>
                <div className="ci-actions">
                  <button className="btn primary sm" onClick={confirmResume}>
                    <Icon name="check" />
                    Confirm resume
                  </button>
                  <button className="btn sm" onClick={() => setResumeNotice(null)}>
                    Cancel — nothing changed
                  </button>
                </div>
              </div>
            ) : (
              <div className="set-save">
                <button className="btn primary sm" onClick={proposeResume}>
                  <Icon name="check" />
                  Resume autonomous sending
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="set-sec">
        <div className="set-head">
          <span className="set-badge">
            <Icon name="gear" />
            Basic
          </span>
          <span className="set-sub">Low-risk — saves immediately, no confirmation</span>
        </div>
        <div className="set-grid">
          <label className="field">
            <span className="fl">Clean approvals required before Tier 1</span>
            <span className="fh">How many clean approvals an account earns before it becomes autonomous.</span>
            <input
              type="number"
              min={1}
              max={4}
              aria-label="Promotion threshold (clean approvals)"
              value={basic.tier1PromotionThreshold}
              onChange={(event) =>
                setBasic({ ...basic, tier1PromotionThreshold: Number(event.target.value) })
              }
            />
          </label>
          <label className="field">
            <span className="fl">Tier 1 audit-sample rate</span>
            <span className="fh">Share of autonomous sends pulled into the Send Audit queue.</span>
            <span className="input-suffix">
              <input
                type="number"
                min={0}
                max={100}
                aria-label="Audit sample rate"
                value={basic.tier1AuditSampleRate}
                onChange={(event) => setBasic({ ...basic, tier1AuditSampleRate: Number(event.target.value) })}
              />
              <i>%</i>
            </span>
          </label>
        </div>
        <div className="set-save">
          <button className="btn primary sm" onClick={() => api.saveBasicSettings(basic).then(setSettings)}>
            <Icon name="check" />
            Save
          </button>
          <span className="set-hint ok">
            <Icon name="checkc" />
            Saves immediately — no confirmation
          </span>
        </div>
      </section>

      <section className="set-sec">
        <button
          type="button"
          className={`set-expander ${advancedOpen ? 'open' : ''}`}
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          <Icon name="chevron" />
          <span className="set-badge alt">Advanced</span>
          <span className="set-sub">Higher-risk — each save needs an explicit confirm step</span>
        </button>

        {advancedOpen && (
          <div className="set-adv-body">
            <div className="set-grid">
              <label className="field">
                <span className="fl">Max follow-ups per account</span>
                <span className="fh">Cap on automated follow-ups before the agent stops.</span>
                <input
                  type="number"
                  min={1}
                  max={5}
                  aria-label="Max follow-ups"
                  value={advanced.maxFollowups}
                  onChange={(event) => setAdvanced({ ...advanced, maxFollowups: Number(event.target.value) })}
                />
              </label>
              <label className="field">
                <span className="fl">Minimum days between follow-ups</span>
                <span className="fh">Quiet period enforced between messages to one account.</span>
                <input
                  type="number"
                  min={3}
                  max={14}
                  aria-label="Minimum days between follow-ups"
                  value={advanced.minDaysBetweenFollowups}
                  onChange={(event) =>
                    setAdvanced({ ...advanced, minDaysBetweenFollowups: Number(event.target.value) })
                  }
                />
              </label>
              <label className="field">
                <span className="fl">Escalation sensitivity</span>
                <span className="fh">
                  Negative-sentiment confidence floor for auto-escalation. Higher = fewer, more certain
                  escalations.
                </span>
                <div className="seg" role="group" aria-label="Escalation sensitivity">
                  {SENTIMENT_LEVELS.map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={advanced.sentimentConfidenceFloor === level ? 'on' : ''}
                      onClick={() => setAdvanced({ ...advanced, sentimentConfidenceFloor: level })}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </label>
            </div>

            <div className="set-save set-save-col">
              {proposal?.requiresConfirmation ? (
                <div className="confirm-inline" data-testid="confirm-advanced">
                  <div className="ci-head">
                    <Icon name="info" />
                    Confirm {proposal.diff.length > 1 ? 'these changes' : 'this change'} before it takes effect
                  </div>
                  <ul className="ci-list">
                    {proposal.diff.map((entry) => (
                      <li key={entry.field}>
                        {entry.field}: {entry.from} → {entry.to}
                      </li>
                    ))}
                  </ul>
                  <div className="ci-note">{proposal.notice}</div>
                  <div className="ci-actions">
                    <button
                      className="btn primary sm"
                      onClick={() =>
                        api.confirmAdvancedSettings(advanced).then((data) => {
                          setSettings(data);
                          setProposal(null);
                        })
                      }
                    >
                      <Icon name="check" />
                      Confirm &amp; apply
                    </button>
                    <button className="btn sm" onClick={() => setProposal(null)}>
                      Cancel — nothing saved
                    </button>
                  </div>
                </div>
              ) : (
                <div className="set-save">
                  <button
                    className="btn primary sm"
                    onClick={() => api.proposeAdvancedSettings(advanced).then(setProposal)}
                  >
                    <Icon name="lock" />
                    Save (requires confirm)
                  </button>
                  <span className="set-hint">
                    One step heavier — clicking opens a confirm step; nothing saves until you confirm
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="set-sec locked" data-testid="locked-settings">
        <div className="set-head">
          <span className="set-badge lock">
            <Icon name="lock" />
            Locked
          </span>
          <span className="set-sub">Visible for reference — policy decisions, not admin-configurable</span>
        </div>
        <div className="lock-list">
          {settings.locked.hardTriggerRules.map((rule) => (
            <div className="lock-row" key={rule.key}>
              <div className="lr-main">
                <div className="lr-name">{rule.label}</div>
                <div className="lr-desc">{rule.description}</div>
              </div>
              <div className="lr-note">
                <Icon name="lock" />
                Locked — policy decision
              </div>
            </div>
          ))}
          <div className="lock-row">
            <div className="lr-main">
              <div className="lr-name">New-account Tier 2 rollout overlay</div>
              <div className="lr-desc">{settings.locked.rolloutOverlayDescription}</div>
            </div>
            <div className="lr-note">
              <Icon name="lock" />
              Locked — policy decision
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
