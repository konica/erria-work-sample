import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { JwtVerifierService } from '../auth/jwt-verifier.service.js';
import { SettingsService } from './settings.service.js';

// Exercises the admin-only gate wired through the real AppModule (proving RolesGuard is actually
// applied to this controller, not just correct in isolation) without a network JWKS fetch or a
// real database.
describe('SettingsController admin gate (e2e, wired through AppModule)', () => {
  let app: INestApplication;
  const read = vi.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JwtVerifierService)
      .useValue({
        verify: (token: string) => {
          if (token === 'admin-token') {
            return Promise.resolve({
              sub: 'ada.admin',
              name: 'Ada Admin',
              realm_access: { roles: ['admin'] },
            });
          }
          if (token === 'reviewer-token') {
            return Promise.resolve({
              sub: 'minh.tran',
              name: 'Minh Tran',
              realm_access: { roles: ['reviewer'] },
            });
          }
          return Promise.reject(new Error('invalid token'));
        },
      })
      .overrideProvider(SettingsService)
      .useValue({ read })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a reviewer-only token with 403, not data', async () => {
    read.mockResolvedValue({ basic: {}, advanced: {}, locked: {} });

    const response = await request(app.getHttpServer())
      .get('/api/settings')
      .set('Authorization', 'Bearer reviewer-token');

    expect(response.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a reviewer-only token on a write endpoint too', async () => {
    const response = await request(app.getHttpServer())
      .put('/api/settings/basic')
      .set('Authorization', 'Bearer reviewer-token')
      .send({ tier1PromotionThreshold: 2, tier1AuditSampleRate: 10 });

    expect(response.status).toBe(403);
  });

  it('allows an admin token through unchanged', async () => {
    read.mockResolvedValue({
      basic: { tier1PromotionThreshold: 2, tier1AuditSampleRate: 10 },
      advanced: { maxFollowups: 2, minDaysBetweenFollowups: 5, sentimentConfidenceFloor: 'Medium' },
      locked: { hardTriggerRules: [], rolloutOverlayEnabled: true, rolloutOverlayDescription: '' },
    });

    const response = await request(app.getHttpServer())
      .get('/api/settings')
      .set('Authorization', 'Bearer admin-token');

    expect(response.status).toBe(200);
    expect(response.body.basic.tier1PromotionThreshold).toBe(2);
  });

  it('still rejects the settings routes with no bearer token at all', async () => {
    const response = await request(app.getHttpServer()).get('/api/settings');

    expect(response.status).toBe(401);
  });
});
