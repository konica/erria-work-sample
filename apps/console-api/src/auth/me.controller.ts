import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from './current-user.decorator.js';
import type { AuthenticatedUser } from './authenticated-user.js';

// Lets the frontend know who is logged in and what they're allowed to see (e.g. whether to show
// the Settings nav item) without duplicating role logic client-side.
@Controller('api/me')
export class MeController {
  @Get()
  get(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
