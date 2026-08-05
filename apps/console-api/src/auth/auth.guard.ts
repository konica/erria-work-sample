import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { toAuthenticatedUser, type AuthenticatedUser } from './authenticated-user.js';
import { JwtVerifierService } from './jwt-verifier.service.js';

const BEARER_PREFIX = 'Bearer ';

interface AuthenticatableRequest {
  path: string;
  headers: { authorization?: string };
  user?: AuthenticatedUser;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwtVerifier: JwtVerifierService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatableRequest>();

    // Scoped to `api/*` (issue #77): `health` and `internal/triggers` have no Keycloak principal
    // to check — the former is a liveness probe, the latter an upstream service-to-service call.
    if (!request.path.startsWith('/api/')) {
      return true;
    }

    const header = request.headers.authorization;
    if (!header?.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const payload = await this.jwtVerifier.verify(header.slice(BEARER_PREFIX.length));
      request.user = toAuthenticatedUser(payload);
    } catch {
      throw new UnauthorizedException('Invalid or expired bearer token');
    }

    return true;
  }
}
