# Keycloak realm (dev)

`realm-export.json` is a full realm import for local development, loaded automatically by
`pnpm compose:up` (`docker compose up -d --wait`, which starts Keycloak with `start-dev
--import-realm`). It defines:

- **Realm:** `erria`
- **Clients:**
  - `console-web` — public client, Authorization Code + PKCE (S256), redirect URI
    `http://localhost:5173/*`. Direct Access Grants (password grant) is also enabled, purely so a
    token can be fetched from the command line for testing (see below) without driving a browser
    through the PKCE dance — not how the SPA itself will log in. `post.logout.redirect.uris` is
    also set to `http://localhost:5173/*` — Keycloak 18+ rejects RP-initiated logout's
    `post_logout_redirect_uri` unless it matches an allow-listed value here, and without a match
    it falls back to its own logout confirmation screen (#76's whole point is that the app never
    shows that screen).
  - `console-api` — bearer-only. It never initiates a login; it only validates tokens issued to
    `console-web` against this realm's JWKS (wired up in #77).
- **Realm roles:** `reviewer`, and `admin` (a composite that includes `reviewer` — an admin token
  carries both roles, per #75's "admin is a superset of reviewer's access").
- **Seeded users**, each a distinct account (no shared logins, per #59):
  - `minh.tran` / `reviewer` — the operator already hardcoded as `DECIDED_BY` in
    `messages.controller.ts` today; #77 replaces that constant with the token's principal, and this
    user's `name` claim resolves to `Minh Tran` so existing `decidedBy` behavior keeps holding.
  - `huy.dinh` / `admin` — a second seeded account for the admin-gated Settings screen (#79). The
    mockup and current sample data only ever name one team member (Minh Tran); this is a new,
    equally fictional teammate added to satisfy "two distinct accounts," not a name pulled from
    existing sample data.

`realm-export.json` itself defines the users but sets no password on them — a hardcoded
credential in that file is exactly the kind of thing GitGuardian's PR check exists to catch, and
did on the first pass of this ticket. Instead, `dev-entrypoint.sh` (the container's entrypoint, in
place of `start-dev --import-realm` directly) starts Keycloak, waits for `/health/ready`, then uses
`kcadm.sh` to set both seeded users' password to `KEYCLOAK_SEED_PASSWORD` (`.env.example` default:
`erria-dev` — a throwaway dev value, same convention as `POSTGRES_PASSWORD=erria` in
`compose.yaml`, not a secret protecting anything real). This realm is never imported into the
deployed environment (`compose.deploy.yaml`, #57/#59, builds its own hardened realm from scratch).

## Fetching a token by hand

```bash
curl -s -X POST http://localhost:8080/realms/erria/protocol/openid-connect/token \
  -d grant_type=password \
  -d client_id=console-web \
  -d username=minh.tran \
  -d password="$KEYCLOAK_SEED_PASSWORD"   # erria-dev by default — see .env
```

Decode the `access_token` (it's a JWT — header.payload.signature, each base64url):

```bash
TOKEN='<paste access_token here>'
echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+' | python3 -c "
import sys, base64, json
payload = sys.stdin.read().strip()
payload += '=' * (-len(payload) % 4)
print(json.dumps(json.loads(base64.b64decode(payload)), indent=2))
"
```

`realm_access.roles` shows `["reviewer"]` for `minh.tran` and `["admin", "reviewer"]` for
`huy.dinh` — the composite expansion happens automatically, no custom mapper needed.

## Admin console

`http://localhost:8080` — bootstrap credentials come from `KEYCLOAK_ADMIN_USER` /
`KEYCLOAK_ADMIN_PASSWORD` in `.env` (defaults `admin`/`admin`). This is a throwaway dev instance;
none of the hardening in #59 (blocking the admin console, MFA, rate limiting) applies here, and
none of it should — that ticket only hardens the deployed realm.

## Regenerating this file

Edit `realm-export.json` directly rather than exporting from a running Keycloak's admin console —
a live export can carry credential hashes and other run-specific noise that don't belong in a
fixture meant to import cleanly every time. Do not add a `credentials` block to a user — passwords
are set post-import by `dev-entrypoint.sh`, precisely so none end up in this file. After editing,
re-run `pnpm compose:reset` and re-fetch a token to confirm the realm still imports and roles still
resolve as expected.
