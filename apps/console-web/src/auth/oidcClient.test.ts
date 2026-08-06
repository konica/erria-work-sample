import { describe, it, expect } from 'vitest';
import { resolveKeycloakAuthority } from './oidcClient.js';

// Ticket #112: clicking Login on the review environment
// (https://erria-outreach.duckdns.org/) sent the browser to a hardcoded
// http://localhost:8080/realms/erria — unreachable from the review env, and even where
// something answered on that host, its Keycloak realm doesn't allow-list the review
// domain's redirect_uri. Root cause: oidcClient.ts's authority never varied by
// environment. These two cases are the environments compose.yaml (dev) and
// compose.deploy.yaml + deploy/Caddyfile (deployed) actually produce.
describe('resolveKeycloakAuthority', () => {
  it('targets the dev Keycloak compose service on its own port, not the app origin, in dev mode', () => {
    expect(resolveKeycloakAuthority(true, 'https://erria-outreach.duckdns.org')).toBe(
      'http://localhost:8080/realms/erria',
    );
  });

  it('targets the app origin under /auth in a production build, matching Caddy + KC_HTTP_RELATIVE_PATH', () => {
    expect(resolveKeycloakAuthority(false, 'https://erria-outreach.duckdns.org')).toBe(
      'https://erria-outreach.duckdns.org/auth/realms/erria',
    );
  });
});
