export type Lang = 'en' | 'da';

// Mirrors shell/theme-bootstrap.ts's THEME_STORAGE_KEY pattern.
export const LANG_STORAGE_KEY = 'erria-lang';

export function resolveInitialLang(stored: string | null): Lang {
  // English-first default per ideation/open-design-brief-landing-login.md — Erria's founding
  // team and its reporting line are English-speaking, Danish is the secondary market.
  return stored === 'da' ? 'da' : 'en';
}

export interface GateCopy {
  productSub: string;
  tagline: string;
  login: string;
  secure: string;
  redirecting: string;
  redirectingSub: string;
  outKicker: string;
  out: string;
  outSub: string;
  expKicker: string;
  exp: string;
  supportLead: string;
}

export const GATE_COPY: Record<Lang, GateCopy> = {
  en: {
    productSub: 'Outreach Console',
    tagline:
      'Internal console for reviewing and sending AI-drafted customer outreach, and handling escalations.',
    login: 'Log in',
    secure: 'Secure sign-in via Keycloak',
    redirecting: 'Redirecting you to sign in…',
    redirectingSub: 'One moment while we hand you to secure sign-in.',
    outKicker: 'Signed out',
    out: "You've been signed out.",
    outSub: 'Sign in again to return to the console.',
    expKicker: 'Session expired',
    exp: 'Your session has expired. Please sign in again.',
    supportLead: 'Questions?',
  },
  da: {
    productSub: 'Outreach-konsol',
    tagline:
      'Intern konsol til gennemgang og afsendelse af AI-genererede kundehenvendelser og håndtering af eskaleringer.',
    login: 'Log ind',
    secure: 'Sikker login via Keycloak',
    redirecting: 'Sender dig videre til login…',
    redirectingSub: 'Et øjeblik – vi sender dig videre til sikkert login.',
    outKicker: 'Logget ud',
    out: 'Du er blevet logget ud.',
    outSub: 'Log ind igen for at vende tilbage til konsollen.',
    expKicker: 'Session udløbet',
    exp: 'Din session er udløbet. Log ind igen.',
    supportLead: 'Spørgsmål?',
  },
};
