import { Injectable } from '@nestjs/common';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { verifyBearerToken } from './jwt-verification.js';

// The realm apps run on the host talk to Keycloak over the published port (compose.yaml), not a
// Docker service name — console-api runs on the host too (`pnpm --filter console-api dev`), same
// as every other app in this repo (see compose.yaml's top comment).
const DEFAULT_ISSUER_URL = 'http://localhost:8080/realms/erria';

@Injectable()
export class JwtVerifierService {
  private readonly issuer: string;
  private readonly getKey: JWTVerifyGetKey;

  constructor() {
    this.issuer = process.env.KEYCLOAK_ISSUER_URL ?? DEFAULT_ISSUER_URL;
    // Memoized once per process: createRemoteJWKSet caches the fetched key set internally and
    // re-fetches only on a kid it hasn't seen, so this must not be rebuilt per request.
    this.getKey = createRemoteJWKSet(new URL(`${this.issuer}/protocol/openid-connect/certs`));
  }

  verify(token: string) {
    return verifyBearerToken(token, this.getKey, this.issuer);
  }
}
