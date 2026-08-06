import type { PrismaClient } from '@erria/db';

export interface Fact {
  kind: 'trigger' | 'vessel' | 'relationship';
  summary: string;
}

/**
 * The enumerated new-fact sources from the autonomous-send design §5. This is deliberately a
 * closed list: "is there anything new?" has to be a computable question, because the alternative
 * is asking the drafting model, which has every incentive to answer yes and would produce exactly
 * the bare "just checking in" that §5 forbids.
 *
 * Note what is NOT a source: Account.updatedAt. It moves on any account write, including a tier
 * change, so using it would invent news every time the tier moved. relationshipSummaryUpdatedAt is
 * set only when that text actually changes.
 */
export async function newFactsSince(
  prisma: PrismaClient,
  accountId: string,
  since: Date,
): Promise<Fact[]> {
  const [triggers, vessels, account] = await Promise.all([
    prisma.trigger.findMany({
      where: { accountId, detectedAt: { gt: since } },
      orderBy: { detectedAt: 'asc' },
    }),
    prisma.vessel.findMany({ where: { accountId, updatedAt: { gt: since } } }),
    prisma.account.findUniqueOrThrow({ where: { id: accountId } }),
  ]);

  const facts: Fact[] = [];

  for (const trigger of triggers) {
    facts.push({ kind: 'trigger', summary: `${trigger.category}: ${trigger.description}` });
  }

  for (const vessel of vessels) {
    facts.push({
      kind: 'vessel',
      summary: `Updated particulars for ${vessel.name} (IMO ${vessel.imo}, flag ${vessel.flag})`,
    });
  }

  if (account.relationshipSummaryUpdatedAt && account.relationshipSummaryUpdatedAt > since) {
    facts.push({ kind: 'relationship', summary: account.relationshipSummary });
  }

  return facts;
}
