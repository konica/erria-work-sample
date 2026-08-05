import type { JWTPayload } from 'jose';

export interface AuthenticatedUser {
  sub: string;
  name: string;
  roles: string[];
}

// Keycloak's default `profile` scope maps `name` to "${firstName} ${lastName}" with no custom
// mapper needed (keycloak/README.md) — that's what makes a seeded user's full name show up as
// `decidedBy`. `preferred_username` is the fallback for a token whose `name` claim is absent.
export function toAuthenticatedUser(payload: JWTPayload): AuthenticatedUser {
  if (typeof payload.sub !== 'string') {
    throw new Error('Token payload is missing "sub"');
  }

  const name =
    typeof payload.name === 'string'
      ? payload.name
      : typeof payload.preferred_username === 'string'
        ? payload.preferred_username
        : payload.sub;

  const realmAccess = payload.realm_access as { roles?: unknown } | undefined;
  const roles = Array.isArray(realmAccess?.roles)
    ? realmAccess.roles.filter((role): role is string => typeof role === 'string')
    : [];

  return { sub: payload.sub, name, roles };
}
