import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { JwtVerifierService } from './jwt-verifier.service.js';
import { MessagesService } from '../messages/messages.service.js';
import { WorkerClient } from '../worker-client/worker-client.service.js';

// Exercises the guard wired up through the real AppModule (proving APP_GUARD registration and
// the api/* path scoping, not just the guard's own unit logic) without a network JWKS fetch or a
// real database — JwtVerifierService, MessagesService and WorkerClient are swapped for fakes.
describe('AuthGuard (e2e, wired through AppModule)', () => {
  let app: INestApplication;
  const approveDraft = vi.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JwtVerifierService)
      .useValue({
        verify: (token: string) => {
          if (token !== 'valid-token') {
            return Promise.reject(new Error('invalid token'));
          }
          return Promise.resolve({
            sub: 'minh.tran',
            name: 'Minh Tran',
            realm_access: { roles: ['reviewer'] },
          });
        },
      })
      .overrideProvider(MessagesService)
      .useValue({ approveDraft })
      .overrideProvider(WorkerClient)
      .useValue({ dispatchMessage: vi.fn().mockResolvedValue(undefined) })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows a non-api route through with no bearer token', async () => {
    const response = await request(app.getHttpServer()).get('/health');
    expect(response.status).toBe(200);
  });

  it('rejects an api route with no bearer token', async () => {
    const response = await request(app.getHttpServer()).post(
      '/api/accounts/acc-1/messages/msg-1/approve',
    );
    expect(response.status).toBe(401);
    expect(approveDraft).not.toHaveBeenCalled();
  });

  it('rejects an api route with an invalid bearer token', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/accounts/acc-1/messages/msg-1/approve')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(response.status).toBe(401);
    expect(approveDraft).not.toHaveBeenCalled();
  });

  it('accepts an api route with a valid bearer token and records the real principal as decidedBy', async () => {
    approveDraft.mockResolvedValue({
      id: 'msg-1',
      status: 'approved',
      decidedBy: 'Minh Tran',
      decidedAt: new Date(),
    });

    const response = await request(app.getHttpServer())
      .post('/api/accounts/acc-1/messages/msg-1/approve')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(201);
    expect(response.body.message.decidedBy).toBe('Minh Tran');
    expect(approveDraft).toHaveBeenCalledWith('acc-1', 'msg-1', 'Minh Tran');
  });
});
