import { describe, it, expect, vi } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard.js';

function contextFor(request: { user?: unknown }) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function reflectorReturning(roles: string[] | undefined) {
  return { getAllAndOverride: vi.fn().mockReturnValue(roles) } as unknown as Reflector;
}

describe('RolesGuard', () => {
  it('allows the request through when no roles are required', () => {
    const guard = new RolesGuard(reflectorReturning(undefined));

    expect(guard.canActivate(contextFor({ user: { sub: 'u', name: 'U', roles: [] } }))).toBe(true);
  });

  it('allows a user whose roles include a required role', () => {
    const guard = new RolesGuard(reflectorReturning(['admin']));

    expect(
      guard.canActivate(contextFor({ user: { sub: 'u', name: 'Ada Admin', roles: ['admin', 'reviewer'] } })),
    ).toBe(true);
  });

  it('rejects a user missing every required role', () => {
    const guard = new RolesGuard(reflectorReturning(['admin']));

    expect(() =>
      guard.canActivate(contextFor({ user: { sub: 'u', name: 'Minh Tran', roles: ['reviewer'] } })),
    ).toThrow(ForbiddenException);
  });

  it('rejects a request with no authenticated user attached', () => {
    const guard = new RolesGuard(reflectorReturning(['admin']));

    expect(() => guard.canActivate(contextFor({}))).toThrow(ForbiddenException);
  });
});
