import type { Prisma } from '../generated/prisma/client.js';

export interface UpsertAccountInput {
  externalRef: string;
  companyName: string;
  segment: string;
  hub: string;
  icpScore: number;
  icpBand: 'high' | 'med' | 'low';
  relationshipSummary: string;
}

export interface UpsertVesselInput {
  name: string;
  imo: string;
  flag: string;
}

export interface UpsertContactInput {
  name: string;
  role: string;
  email?: string | null;
}

/**
 * Upserts an Account by its natural key (`externalRef`). A brand-new account always lands at Tier
 * 2 with a `create` TierHistoryEvent — the rollout overlay (ADR-0004): every new account is held
 * at Tier 2 minimum until it earns Tier 1 via clean approvals, never created there directly.
 *
 * Takes a `Prisma.TransactionClient` rather than opening its own transaction, so a caller that
 * needs the account, vessel, and contact writes to land atomically (e.g. one CSV row) composes
 * this inside its own `prisma.$transaction(...)` rather than nesting one.
 */
export async function upsertAccount(tx: Prisma.TransactionClient, input: UpsertAccountInput) {
  const existing = await tx.account.findUnique({ where: { externalRef: input.externalRef } });

  if (existing) {
    return tx.account.update({
      where: { id: existing.id },
      data: {
        companyName: input.companyName,
        segment: input.segment,
        hub: input.hub,
        icpScore: input.icpScore,
        icpBand: input.icpBand,
        relationshipSummary: input.relationshipSummary,
      },
    });
  }

  const created = await tx.account.create({
    data: {
      externalRef: input.externalRef,
      companyName: input.companyName,
      segment: input.segment,
      hub: input.hub,
      icpScore: input.icpScore,
      icpBand: input.icpBand,
      relationshipSummary: input.relationshipSummary,
      currentTier: 2,
      tierRationale: 'New account — rollout default per spec §3 until 2 clean approvals',
    },
  });

  await tx.tierHistoryEvent.create({
    data: {
      accountId: created.id,
      eventType: 'create',
      toTier: 2,
      reason: 'Account created via incoming trigger — rollout default (spec §3)',
    },
  });

  return created;
}

/** Upserts a Vessel by its natural key (`imo`, unique across all accounts). */
export async function upsertVessel(
  tx: Prisma.TransactionClient,
  accountId: string,
  input: UpsertVesselInput,
) {
  return tx.vessel.upsert({
    where: { imo: input.imo },
    update: { name: input.name, flag: input.flag, accountId },
    create: { accountId, name: input.name, imo: input.imo, flag: input.flag },
  });
}

/**
 * Upserts a Contact. Contact has no unique constraint to upsert against (a person is identified
 * by their email within an account, but email is nullable), so match explicitly then insert or
 * update.
 */
export async function upsertContact(
  tx: Prisma.TransactionClient,
  accountId: string,
  input: UpsertContactInput,
) {
  const existing = input.email
    ? await tx.contact.findFirst({ where: { accountId, email: input.email } })
    : await tx.contact.findFirst({ where: { accountId, name: input.name } });

  if (existing) {
    return tx.contact.update({
      where: { id: existing.id },
      data: { name: input.name, role: input.role, email: input.email ?? null },
    });
  }

  return tx.contact.create({
    data: { accountId, name: input.name, role: input.role, email: input.email ?? null },
  });
}
