import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

const REALM = 'erria';

// Ticket #112: console-web is built once (apps/console-api/Dockerfile) and that same
// bundle is served both by Vite's dev server and, deployed, by console-api itself
// (ADR-0007) — so the Keycloak authority can't be a single hardcoded string. The two
// cases are exactly the two Keycloak setups compose.yaml/compose.deploy.yaml produce:
// dev's Keycloak is a separate compose service on its own port with no path prefix
// (KEYCLOAK_PORT, default 8080), while deploy/Caddyfile reverse-proxies the deployed
// Keycloak under /auth on the app's own origin (KC_HTTP_RELATIVE_PATH in
// compose.deploy.yaml). `import.meta.env.DEV` is Vite's own dev-vs-build signal, true
// under `vite dev` and false in the `vite build` output that ships to production —
// exactly the distinction needed here, with no new env var to wire through the Docker
// build.
export function resolveKeycloakAuthority(isDev: boolean, origin: string): string {
  return isDev ? `http://localhost:8080/realms/${REALM}` : `${origin}/auth/realms/${REALM}`;
}

export function createUserManager(): UserManager {
  return new UserManager({
    authority: resolveKeycloakAuthority(import.meta.env.DEV, window.location.origin),
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
