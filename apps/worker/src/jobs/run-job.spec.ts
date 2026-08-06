import { describe, it, expect } from 'vitest';
import { runJob } from './run-job.js';

describe('runJob', () => {
  it('throws on an unknown job name', async () => {
    await expect(runJob('not-a-real-job')).rejects.toThrow('Unknown job');
  });

  it('resolves for a known job name that has no body yet, without throwing', async () => {
    await expect(runJob('audit-sample-maintenance')).resolves.toBeUndefined();
  });
});
