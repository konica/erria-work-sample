import { describe, it, expect } from 'vitest';
import { buildSubjectLine } from './subject-line.js';

describe('buildSubjectLine', () => {
  it('matches the spec §6 worked example when a vessel is known', () => {
    expect(
      buildSubjectLine({
        companyName: 'Song Hong Shipping',
        vesselName: 'MV Song Hong Pioneer',
        triggerCategory: 'life-raft service window',
      }),
    ).toBe("Quick note on MV Song Hong Pioneer's life-raft service window");
  });

  it('falls back to the company name when there is no vessel', () => {
    expect(
      buildSubjectLine({
        companyName: 'Song Hong Shipping',
        vesselName: null,
        triggerCategory: 'life-raft service window',
      }),
    ).toBe("Quick note on Song Hong Shipping's life-raft service window");
  });

  it('falls back to the name alone when there is no trigger category either', () => {
    expect(
      buildSubjectLine({ companyName: 'Song Hong Shipping', vesselName: null, triggerCategory: null }),
    ).toBe('Quick note on Song Hong Shipping');
  });

  it('does not produce a doubled s on a name that already ends in one', () => {
    expect(
      buildSubjectLine({
        companyName: 'Vinh Long Coastal Services',
        vesselName: null,
        triggerCategory: 'EPIRB battery expiry',
      }),
    ).toBe("Quick note on Vinh Long Coastal Services' EPIRB battery expiry");
  });
});
