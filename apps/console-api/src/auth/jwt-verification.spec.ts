import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { verifyBearerToken } from './jwt-verification.js';

const ISSUER = 'http://localhost:8080/realms/erria';

describe('verifyBearerToken', () => {
  let getKey: ReturnType<typeof createLocalJWKSet>;
  let sign: (payload: Record<string, unknown>) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const publicJwk: JWK = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'test-key' };
    getKey = createLocalJWKSet({ keys: [publicJwk] });

    sign = (payload) =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
  });

  it('returns the payload for a token signed by a key in the JWKS with the expected issuer', async () => {
    const token = await sign({ sub: 'user-1', name: 'Minh Tran' });

    const payload = await verifyBearerToken(token, getKey, ISSUER);

    expect(payload).toMatchObject({ sub: 'user-1', name: 'Minh Tran' });
  });

  it('rejects a token issued by a different issuer', async () => {
    const token = await sign({ sub: 'user-1' });

    await expect(verifyBearerToken(token, getKey, 'http://localhost:8080/realms/other')).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const expired = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(privateKey);

    await expect(verifyBearerToken(expired, getKey, ISSUER)).rejects.toThrow();
  });

  it('rejects a token signed by a key not present in the JWKS', async () => {
    const { privateKey: otherPrivateKey } = await generateKeyPair('RS256');
    const forged = await new SignJWT({ sub: 'user-1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(otherPrivateKey);

    await expect(verifyBearerToken(forged, getKey, ISSUER)).rejects.toThrow();
  });
});
