import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

// Split out from JwtVerifierService so tests can exercise real signature/issuer/expiry checking
// against a `createLocalJWKSet` fixture instead of stubbing `jose` or hitting a network JWKS URI.
export function verifyBearerToken(
  token: string,
  getKey: JWTVerifyGetKey,
  issuer: string,
): Promise<JWTPayload> {
  return jwtVerify(token, getKey, { issuer }).then(({ payload }) => payload);
}
