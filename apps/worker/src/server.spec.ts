import { describe, it, expect } from 'vitest';
import { buildServer } from './server.js';

describe('worker health', () => {
  it('GET /health returns ok', async () => {
    const server = buildServer();
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
