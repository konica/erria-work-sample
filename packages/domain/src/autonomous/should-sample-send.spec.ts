import { describe, it, expect } from 'vitest';
import { shouldSampleSend } from './should-sample-send.js';

describe('shouldSampleSend', () => {
  it("always samples an account's first autonomous send, whatever the rate", () => {
    expect(
      shouldSampleSend({ sampleRatePercent: 0, isFirstAutonomousSend: true, random: () => 0.99 }),
    ).toBe(true);
  });

  it('samples when the roll falls inside the configured rate', () => {
    expect(
      shouldSampleSend({ sampleRatePercent: 10, isFirstAutonomousSend: false, random: () => 0.05 }),
    ).toBe(true);
  });

  it('does not sample when the roll falls outside the rate', () => {
    expect(
      shouldSampleSend({ sampleRatePercent: 10, isFirstAutonomousSend: false, random: () => 0.5 }),
    ).toBe(false);
  });

  it('never samples at a rate of 0 once past the first send', () => {
    expect(
      shouldSampleSend({ sampleRatePercent: 0, isFirstAutonomousSend: false, random: () => 0 }),
    ).toBe(false);
  });

  it('always samples at a rate of 100', () => {
    expect(
      shouldSampleSend({ sampleRatePercent: 100, isFirstAutonomousSend: false, random: () => 0.999 }),
    ).toBe(true);
  });
});
