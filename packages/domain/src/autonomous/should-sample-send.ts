export interface ShouldSampleInput {
  sampleRatePercent: number;
  isFirstAutonomousSend: boolean;
  /** Injected so the rate is testable. Never call Math.random() inside this module. */
  random: () => number;
}

/**
 * Spec §10's sampling rate, plus the design's one addition: an account's first autonomous send is
 * always sampled. The first message an account sends with nobody reading it is the riskiest one it
 * will ever send, so it is a strange place to economise on a dice roll.
 */
export function shouldSampleSend(input: ShouldSampleInput): boolean {
  if (input.isFirstAutonomousSend) {
    return true;
  }
  // Strict less-than against a 0..1 roll: rate 0 samples nothing, rate 100 samples everything.
  return input.random() < input.sampleRatePercent / 100;
}
