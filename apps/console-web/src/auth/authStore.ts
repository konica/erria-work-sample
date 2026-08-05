import type { User } from 'oidc-client-ts';
import { userManager } from './oidcClient.js';

// The four gate states from ideation/open-design-brief-landing-login.md, plus 'loading' for
// the brief window before initAuth() resolves what to show first.
export type AuthView = 'loading' | 'landing' | 'redirecting' | 'authenticated' | 'loggedOut' | 'expired';

export interface AuthState {
  view: AuthView;
  user: User | null;
}

// Session flag set immediately before the RP-initiated logout redirect, read back once the
// browser lands back on this origin — the only way to tell "fresh landing" apart from
// "just logged out" once Keycloak's own confirmation screen has been skipped.
const LOGOUT_FLAG_KEY = 'erria-just-logged-out';

let state: AuthState = { view: 'loading', user: null };
const listeners = new Set<() => void>();

function setState(next: Partial<AuthState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): AuthState {
  return state;
}

export function getAccessToken(): string | null {
  return state.user?.access_token ?? null;
}

/** Called by the API layer on a 401 — the token is no longer good for anything. */
export function reportUnauthorized(): void {
  if (state.view !== 'authenticated') return;
  void userManager.removeUser();
  setState({ view: 'expired', user: null });
}

export async function login(): Promise<void> {
  setState({ view: 'redirecting' });
  await userManager.signinRedirect();
}

export async function logout(): Promise<void> {
  sessionStorage.setItem(LOGOUT_FLAG_KEY, '1');
  // signoutRedirect pulls id_token_hint from the current user automatically and pairs it
  // with post_logout_redirect_uri, so Keycloak's own logout confirmation is skipped and the
  // browser lands straight back on this origin's "You've been signed out" state.
  await userManager.signoutRedirect();
}

userManager.events.addUserLoaded((user) => setState({ view: 'authenticated', user }));
userManager.events.addAccessTokenExpired(() => setState({ view: 'expired', user: null }));

let initPromise: Promise<void> | null = null;

// Memoized so React StrictMode's double-invoked effect (or any other duplicate caller) can't
// run this twice — signinRedirectCallback()'s authorization code is single-use, and a second
// call would fail and stomp the 'authenticated' state the first call just set.
export function initAuth(): Promise<void> {
  if (!initPromise) initPromise = runInitAuth();
  return initPromise;
}

async function runInitAuth(): Promise<void> {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.has('code') && params.has('state')) {
      await userManager.signinRedirectCallback();
      window.history.replaceState({}, '', window.location.pathname);
      // addUserLoaded (above) flips the view to 'authenticated'.
      return;
    }

    if (sessionStorage.getItem(LOGOUT_FLAG_KEY)) {
      sessionStorage.removeItem(LOGOUT_FLAG_KEY);
      setState({ view: 'loggedOut', user: null });
      return;
    }

    const user = await userManager.getUser();
    if (user && !user.expired) {
      setState({ view: 'authenticated', user });
    } else if (user) {
      setState({ view: 'expired', user: null });
    } else {
      setState({ view: 'landing', user: null });
    }
  } catch (err) {
    console.error('Auth initialization failed', err);
    setState({ view: 'landing', user: null });
  }
}
