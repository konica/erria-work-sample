import { describe, it, expect } from 'vitest';
import { runJob } from './run-job.js';

describe('runJob', () => {
  it('throws on an unknown job name', async () => {
    await expect(runJob('not-a-real-job')).rejects.toThrow('Unknown job');
  });

  it('resolves for each known job name without throwing', async () => {
    await expect(runJob('followup-cadence')).resolves.toBeUndefined();
  });
});
