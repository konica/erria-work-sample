import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { AuthGuard } from './auth.guard.js';
import type { JwtVerifierService } from './jwt-verifier.service.js';

function contextFor(request: {
  path: string;
  headers: Record<string, string | undefined>;
  user?: unknown;
}) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
  it('lets non-api routes through without checking for a token', async () => {
    const verify = vi.fn();
    const guard = new AuthGuard({ verify } as unknown as JwtVerifierService);

    const request = { path: '/health', headers: {} };
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects an api route with no Authorization header', async () => {
    const guard = new AuthGuard({ verify: vi.fn() } as unknown as JwtVerifierService);

    await expect(
      guard.canActivate(contextFor({ path: '/api/queue', headers: {} })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an api route whose Authorization header is not a bearer token', async () => {
    const guard = new AuthGuard({ verify: vi.fn() } as unknown as JwtVerifierService);

    await expect(
      guard.canActivate(
        contextFor({ path: '/api/queue', headers: { authorization: 'Basic abc123' } }),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an api route whose token fails verification', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('bad signature'));
    const guard = new AuthGuard({ verify } as unknown as JwtVerifierService);

    await expect(
      guard.canActivate(
        contextFor({ path: '/api/queue', headers: { authorization: 'Bearer bad-token' } }),
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(verify).toHaveBeenCalledWith('bad-token');
  });

  it('attaches the authenticated user to the request and allows the api route through', async () => {
    const verify = vi.fn().mockResolvedValue({
      sub: 'user-1',
      name: 'Minh Tran',
      realm_access: { roles: ['reviewer'] },
    });
    const guard = new AuthGuard({ verify } as unknown as JwtVerifierService);

    const request: { path: string; headers: Record<string, string>; user?: unknown } = {
      path: '/api/queue',
      headers: { authorization: 'Bearer good-token' },
    };
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toEqual({ sub: 'user-1', name: 'Minh Tran', roles: ['reviewer'] });
  });
});
