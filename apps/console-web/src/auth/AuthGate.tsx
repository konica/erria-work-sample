import { useState } from 'react';
import { Icon } from '../shell/icons.js';
import { ThemeToggle } from '../shell/ThemeToggle.js';
import { LangToggle } from '../i18n/LangToggle.js';
import { GATE_COPY, LANG_STORAGE_KEY, resolveInitialLang, type GateCopy, type Lang } from '../i18n/lang.js';
import { useAuth } from './useAuth.js';

function currentLang(): Lang {
  try {
    return resolveInitialLang(localStorage.getItem(LANG_STORAGE_KEY));
  } catch {
    return 'en';
  }
}

function LoginCta({ t, onLogin }: { t: GateCopy; onLogin: () => void }) {
  return (
    <>
      <button type="button" className="btn-login" onClick={onLogin}>
        {t.login}
        <Icon name="arrow" />
      </button>
      <p className="secure">
        <Icon name="lock" />
        {t.secure}
      </p>
    </>
  );
}

/*
 * Renders the three non-authenticated gate states from
 * ideation/open-design-brief-landing-login.md (Landing, Redirecting, Signed out, Session
 * expired share one shell — Redirecting has no CTA, since it's transient and auto-dismissing
 * once the browser navigates to Keycloak).
 */
export function AuthGate() {
  const { view, login } = useAuth();
  const [lang, setLang] = useState<Lang>(currentLang);
  const t = GATE_COPY[lang];

  function changeLang(next: Lang) {
    setLang(next);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      // localStorage unavailable (e.g. private browsing) — language still applies for this session
    }
  }

  return (
    <div className="gate" data-gate-view={view}>
      <div className="gate-topbar">
        <div className="spacer" />
        <LangToggle lang={lang} onChange={changeLang} />
        <ThemeToggle />
      </div>

      <main className="center">
        <section className="card">
          <div className="gate-brand">
            <div className="gate-logo">
              <img src="/erria-logo.png" alt="Erria" />
            </div>
            <div className="wordmark">
              Erria Outreach Agent
              <span className="wordmark-sub">{t.productSub}</span>
            </div>
          </div>

          {view === 'redirecting' ? (
            <div className="state">
              <div className="spin" role="status" aria-live="polite" />
              <p className="status">{t.redirecting}</p>
              <p className="sub">{t.redirectingSub}</p>
            </div>
          ) : view === 'loggedOut' ? (
            <div className="state">
              <span className="kicker ok">
                <Icon name="checkc" />
                {t.outKicker}
              </span>
              <p className="status">{t.out}</p>
              <p className="sub">{t.outSub}</p>
              <LoginCta t={t} onLogin={login} />
            </div>
          ) : view === 'expired' ? (
            <div className="state">
              <span className="kicker warn">
                <Icon name="escalation" />
                {t.expKicker}
              </span>
              <p className="status">{t.exp}</p>
              <LoginCta t={t} onLogin={login} />
            </div>
          ) : (
            <div className="state">
              <p className="tagline">{t.tagline}</p>
              <LoginCta t={t} onLogin={login} />
            </div>
          )}
        </section>
      </main>

      <footer className="gate-foot">
        <span className="ver">
          <span className="dot" />
          v0.4 · staging
        </span>
        <span className="support">
          {t.supportLead} <a href="mailto:support@erria.dk">support@erria.dk</a>
        </span>
      </footer>
    </div>
  );
}
