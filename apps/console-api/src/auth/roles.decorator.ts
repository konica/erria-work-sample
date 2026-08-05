import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

/** Marks a route or controller as requiring at least one of the given realm roles. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
