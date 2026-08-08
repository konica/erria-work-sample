export interface Credentials {
  username: string;
  password: string;
}

export interface E2eEnv {
  baseUrl: string;
  reviewer: Credentials;
  admin: Credentials;
}

function readEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : fallback;
}

/**
 * Defaults match the two dev-seeded Keycloak users from `keycloak/dev-entrypoint.sh`
 * (minh.tran / reviewer, huy.dinh / admin, both `KEYCLOAK_SEED_PASSWORD`) so `pnpm test:e2e`
 * works out of the box against `pnpm compose:up` without provisioning anything extra. Point
 * BASE_URL/UAT_* at a different environment (e.g. the review deployment, #82) to reuse the same
 * suite there — see this package's README.
 */
export function loadE2eEnv(): E2eEnv {
  return {
    baseUrl: readEnv('BASE_URL', 'http://localhost:5173'),
    reviewer: {
      username: readEnv('UAT_REVIEWER_USERNAME', 'minh.tran'),
      password: readEnv('UAT_REVIEWER_PASSWORD', 'erria-dev'),
    },
    admin: {
      username: readEnv('UAT_ADMIN_USERNAME', 'huy.dinh'),
      password: readEnv('UAT_ADMIN_PASSWORD', 'erria-dev'),
    },
  };
}
