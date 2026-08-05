import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

// Dev-only Keycloak address, same convention as vite.config.ts's proxy target
// (http://localhost:3000) and compose.yaml's KEYCLOAK_PORT default (8080) — this app
// hardcodes local dev assumptions rather than reading env, matching the rest of console-web.
const KEYCLOAK_URL = 'http://localhost:8080';
const REALM = 'erria';

export function createUserManager(): UserManager {
  return new UserManager({
    authority: `${KEYCLOAK_URL}/realms/${REALM}`,
    client_id: 'console-web',
    redirect_uri: `${window.location.origin}/`,
    post_logout_redirect_uri: `${window.location.origin}/`,
    response_type: 'code',
    scope: 'openid profile email',
    // Session-scoped, not localStorage: matches the "idle tab" session-expiry story in the
    // design brief, and avoids an access/refresh token surviving a closed browser.
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    // Renews the access token before it expires. oidc-client-ts's signinSilent() reaches for
    // the refresh_token grant automatically whenever the current user has one — a plain POST
    // to the token endpoint — and only falls back to an iframe-based silent renew otherwise.
    // Keycloak issues a refresh token to console-web's standard-flow client by default, so
    // renewal here never needs an iframe or a separate silent-renew redirect URI.
    automaticSilentRenew: true,
  });
}

export const userManager = createUserManager();
