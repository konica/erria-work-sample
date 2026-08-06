import { Icon } from './shell/icons.js';

export function TierBadge({ tier }: { tier: number }) {
  if (tier === 1) {
    return (
      <span className="badge t1">
        <Icon name="robot" />
        Tier 1 · Autonomous
      </span>
    );
  }
  if (tier === 3) {
    return (
      <span className="badge t3">
        <Icon name="escalation" />
        Tier 3 · Escalated
      </span>
    );
  }
  return (
    <span className="badge t2">
      <Icon name="pencil" />
      Tier 2 · Needs approval
    </span>
  );
}
