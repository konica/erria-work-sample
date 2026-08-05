import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../app.module.js';
import { JwtVerifierService } from './jwt-verifier.service.js';

describe('MeController (e2e, wired through AppModule)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(JwtVerifierService)
      .useValue({
        verify: (token: string) => {
          if (token !== 'admin-token') return Promise.reject(new Error('invalid token'));
          return Promise.resolve({
            sub: 'ada.admin',
            name: 'Ada Admin',
            realm_access: { roles: ['admin'] },
          });
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the current principal decoded from the bearer token', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', 'Bearer admin-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ sub: 'ada.admin', name: 'Ada Admin', roles: ['admin'] });
  });

  it('rejects a request with no bearer token', async () => {
    const response = await request(app.getHttpServer()).get('/api/me');

    expect(response.status).toBe(401);
  });
});
