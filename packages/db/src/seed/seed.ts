import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config as loadEnv } from 'dotenv';
import type { PrismaClient } from '../generated/prisma/client.js';
import { upsertAccount, upsertContact, upsertVessel } from './upsert-entities.js';

/**
 * Fixed natural keys for the four seed accounts — also the idempotency guard: if any of these
 * already exists, the whole seed is treated as already applied and nothing is written. This is
 * the "refuses or is explicitly idempotent" requirement (issue #54) satisfied the simple way: a
 * clean database gets exactly one seed run's worth of data, and a re-run is a safe no-op rather
 * than a duplicate.
 */
const SEED_EXTERNAL_REFS = [
  'seed-song-hong-shipping',
  'seed-truong-phat-marine',
  'seed-dai-duong-shipping',
  'seed-vina-offshore-supply',
] as const;

export interface SeedResult {
  seeded: boolean;
}

/**
 * Seeds four fictional accounts — all names lifted from the approved mockup
 * (brainstorm/mockup/Erria-outreach-agent-v06/outreach-console.html), never invented here — that
 * together exercise the console rather than one happy row (issue #54):
 *
 * - Song Hong Shipping: Tier 2, a pending draft awaiting approval — the primary queue row.
 * - Truong Phat Marine: Tier 3, an active escalation (pricing question, Hard-Trigger Rule).
 * - Dai Duong Shipping: Tier 3, a *resolved* escalation (negative sentiment) — tier stays 3
 *   afterward (spec §7: resolving an escalation never restores tier automatically).
 * - Vina Offshore Supply: a trigger too thin to draft — the abstain path (Trigger.status =
 *   'needs_triage', no Message row), same outcome the worker's own abstain handling produces.
 */
export async function seedDemoData(prisma: PrismaClient): Promise<SeedResult> {
  const alreadySeeded = await prisma.account.findFirst({
    where: { externalRef: { in: [...SEED_EXTERNAL_REFS] } },
  });
  if (alreadySeeded) {
    return { seeded: false };
  }

  await seedSongHongShipping(prisma);
  await seedTruongPhatMarine(prisma);
  await seedDaiDuongShipping(prisma);
  await seedVinaOffshoreSupply(prisma);

  return { seeded: true };
}

async function seedSongHongShipping(prisma: PrismaClient) {
  await prisma.$transaction(async (tx) => {
    const account = await upsertAccount(tx, {
      externalRef: 'seed-song-hong-shipping',
      companyName: 'Song Hong Shipping',
      segment: 'Offshore support vessel operator',
      hub: 'Haiphong',
      icpScore: 82,
      icpBand: 'high',
      relationshipSummary: 'New account · first contact 12 Jul 2026 · 1 prior message',
    });

    await tx.account.update({
      where: { id: account.id },
      data: {
        currentTier: 2,
        tierRationale: 'New account — Tier 2 minimum until 2 clean approvals (1 of 2)',
        cleanApprovalsCount: 1,
      },
    });

    await tx.tierHistoryEvent.create({
      data: {
        accountId: account.id,
        eventType: 'clean_approval',
        fromTier: 2,
        toTier: 2,
        reason: 'First outreach approved without edits — clean approval 1 of 2',
      },
    });

    const vessel = await upsertVessel(tx, account.id, {
      name: 'MV Song Hong Pioneer',
      imo: '9482137',
      flag: 'Vietnam',
    });

    await upsertContact(tx, account.id, {
      name: 'Ms. Lan Pham',
      role: 'Technical Superintendent',
      email: 'lan.pham@example.com',
    });

    const trigger = await tx.trigger.create({
      data: {
        accountId: account.id,
        vesselId: vessel.id,
        category: 'life-raft service window',
        description: 'Life-raft servicing approaching next window — no rebooking found in CRM',
        source: 'public_data',
        confidenceLabel: 'mid',
        verifiabilityNote:
          "Partly verifiable — last service date on file (14 Aug 2025); the 12-month service " +
          'interval is illustrative, not a confirmed SOLAS figure',
        detectedAt: new Date('2026-08-02T09:48:00.000Z'),
        status: 'drafted',
      },
    });

    await tx.message.create({
      data: {
        accountId: account.id,
        triggerId: trigger.id,
        role: 'agent_draft',
        body:
          "Hi Ms. Pham, I hope this finds you well. Based on publicly available vessel " +
          "particulars, it looks like MV Song Hong Pioneer's life-raft equipment may be " +
          'approaching a typical service interval. If it would help, we’d be glad to check ' +
          "availability at our Vung Tau station and share a few dates — no obligation, just " +
          "flagging it in case it's useful for your maintenance planning.",
        status: 'pending_review',
        tierContext: 2,
        confidenceMeta: { model: 'claude-sonnet-5', confidenceLabel: 'mid' },
      },
    });
  });
}

async function seedTruongPhatMarine(prisma: PrismaClient) {
  await prisma.$transaction(async (tx) => {
    const account = await upsertAccount(tx, {
      externalRef: 'seed-truong-phat-marine',
      companyName: 'Truong Phat Marine',
      segment: 'Bulk carrier operator',
      hub: 'Ho Chi Minh City',
      icpScore: 85,
      icpBand: 'high',
      relationshipSummary: 'Active account · 1 prior message · escalated thread open',
    });

    await tx.account.update({
      where: { id: account.id },
      data: {
        currentTier: 3,
        tierRationale: 'Escalated — pricing question requires a human (Hard-Trigger Rule)',
      },
    });

    await tx.tierHistoryEvent.create({
      data: {
        accountId: account.id,
        eventType: 'escalate',
        fromTier: 2,
        toTier: 3,
        reason: 'Pricing question — Hard-Trigger Rule overrides tier and routes to a human',
      },
    });

    const vessel = await upsertVessel(tx, account.id, {
      name: 'MV Blue Horizon',
      imo: '9556781',
      flag: 'Vietnam',
    });

    await upsertContact(tx, account.id, {
      name: 'Mr. Duc Nguyen',
      role: 'Purchasing Manager',
      email: 'duc.nguyen@example.com',
    });

    const trigger = await tx.trigger.create({
      data: {
        accountId: account.id,
        vesselId: vessel.id,
        category: 'fire-fighting recertification window',
        description: "MV Blue Horizon's fire-fighting equipment recertification looks due at Vung Tau",
        source: 'class_records',
        confidenceLabel: 'high',
        verifiabilityNote: 'Verifiable — class record cross-checked',
        detectedAt: new Date('2026-07-28T00:00:00.000Z'),
        status: 'drafted',
      },
    });

    await tx.message.create({
      data: {
        accountId: account.id,
        triggerId: trigger.id,
        role: 'agent_sent',
        body:
          "Hi Mr. Nguyen, MV Blue Horizon's fire-fighting equipment recertification looks due at " +
          "Vung Tau. We can hold a slot if that's useful — happy to share dates.",
        status: 'sent',
        tierContext: 2,
        decidedBy: 'M. Tran',
        decidedAt: new Date('2026-07-28T00:00:00.000Z'),
        sentAt: new Date('2026-07-28T00:05:00.000Z'),
      },
    });

    const inboundMessage = await tx.message.create({
      data: {
        accountId: account.id,
        role: 'buyer_inbound',
        body:
          'Thanks. What would a full recert for the fire-fighting system run us at Vung Tau, ' +
          "roughly? I need a ballpark for this quarter's budget before I commit to a date.",
        status: 'sent',
        tierContext: 2,
      },
    });

    await tx.escalation.create({
      data: {
        accountId: account.id,
        triggerMessageId: inboundMessage.id,
        hardTriggerRule: 'pricing_question',
        reasonSummary: 'Pricing question — human required',
        detail:
          'The buyer asked for a concrete price. The agent is not permitted to quote — pricing ' +
          'must come from a human with commercial authority.',
        recommendedNextStep:
          'Send an indicative quote for full fire-fighting system recertification at the Vung ' +
          'Tau station (2 CO₂ banks + foam), and confirm two available service dates this ' +
          'month. Note that final pricing depends on on-site inspection.',
        agentSendDisabled: true,
        status: 'active',
      },
    });
  });
}

async function seedDaiDuongShipping(prisma: PrismaClient) {
  await prisma.$transaction(async (tx) => {
    const account = await upsertAccount(tx, {
      externalRef: 'seed-dai-duong-shipping',
      companyName: 'Dai Duong Shipping',
      segment: 'Product tanker operator',
      hub: 'Ho Chi Minh City',
      icpScore: 68,
      icpBand: 'med',
      relationshipSummary: 'Active account · 1 prior message · escalation resolved',
    });

    await tx.account.update({
      where: { id: account.id },
      data: {
        currentTier: 3,
        tierRationale:
          'Escalated to Tier 3 on negative sentiment (spec §7 — resolving the escalation does not restore tier)',
      },
    });

    await tx.tierHistoryEvent.create({
      data: {
        accountId: account.id,
        eventType: 'escalate',
        fromTier: 2,
        toTier: 3,
        reason: 'Negative sentiment — relationship conflict (open billing dispute)',
      },
    });

    const vessel = await upsertVessel(tx, account.id, {
      name: 'MV Pearl Ambassador',
      imo: '9601234',
      flag: 'Vietnam',
    });

    await upsertContact(tx, account.id, {
      name: 'Mr. Son Vo',
      role: 'Technical Manager',
      email: 'son.vo@example.com',
    });

    const trigger = await tx.trigger.create({
      data: {
        accountId: account.id,
        vesselId: vessel.id,
        category: 'life-raft service window',
        description: "MV Pearl Ambassador's upcoming liferaft service window",
        source: 'public_data',
        confidenceLabel: 'mid',
        verifiabilityNote: 'Partly verifiable — service interval is illustrative',
        detectedAt: new Date('2026-07-25T00:00:00.000Z'),
        status: 'drafted',
      },
    });

    await tx.message.create({
      data: {
        accountId: account.id,
        triggerId: trigger.id,
        role: 'agent_sent',
        body:
          "Hi Mr. Vo, checking in on MV Pearl Ambassador's upcoming liferaft service window — " +
          "we'd be glad to help schedule at Vung Tau.",
        status: 'sent',
        tierContext: 2,
        decidedBy: 'M. Tran',
        decidedAt: new Date('2026-07-25T00:00:00.000Z'),
        sentAt: new Date('2026-07-25T00:05:00.000Z'),
      },
    });

    const inboundMessage = await tx.message.create({
      data: {
        accountId: account.id,
        role: 'buyer_inbound',
        body:
          'Before anything new — our last invoice from Erria had a charge we never agreed to ' +
          "and it's still unresolved. I'm not scheduling more work until that's sorted.",
        status: 'sent',
        tierContext: 2,
      },
    });

    const escalation = await tx.escalation.create({
      data: {
        accountId: account.id,
        triggerMessageId: inboundMessage.id,
        hardTriggerRule: 'negative_sentiment',
        reasonSummary: 'Negative sentiment — relationship conflict',
        detail:
          'The buyer raised a past billing dispute. Sentiment is negative and the topic touches ' +
          'an unresolved commercial issue — the agent must not respond autonomously.',
        recommendedNextStep:
          'Acknowledge the invoice concern directly, loop in the Vung Tau station accounts ' +
          'contact to review the disputed charge, and hold any new service outreach until it is ' +
          'resolved. Do not lead with a new sales offer.',
        agentSendDisabled: true,
        status: 'resolved',
        resolvedAt: new Date('2026-07-29T11:05:00.000Z'),
      },
    });

    await tx.resolution.create({
      data: {
        escalationId: escalation.id,
        accountId: account.id,
        actionType: 'mark_resolved',
        actionTaken: 'Escalated to AE — billing dispute handoff',
        outcomeTag: 'no_response',
        resolvedBy: 'M. Tran',
        createdAt: new Date('2026-07-29T11:05:00.000Z'),
      },
    });
  });
}

async function seedVinaOffshoreSupply(prisma: PrismaClient) {
  await prisma.$transaction(async (tx) => {
    const account = await upsertAccount(tx, {
      externalRef: 'seed-vina-offshore-supply',
      companyName: 'Vina Offshore Supply',
      segment: 'Offshore support vessel operator',
      hub: 'Vung Tau',
      icpScore: 64,
      icpBand: 'med',
      relationshipSummary: 'New account · no prior contact on file',
    });

    const vessel = await upsertVessel(tx, account.id, {
      name: 'MV Cua Lo Spirit',
      imo: '9550281',
      flag: 'Vietnam',
    });

    await upsertContact(tx, account.id, {
      name: 'Ms. Quyen Bui',
      role: 'Purchasing Manager',
      email: 'quyen.bui@example.com',
    });

    await tx.trigger.create({
      data: {
        accountId: account.id,
        vesselId: vessel.id,
        category: 'fire-extinguisher recertification window',
        description: 'Fire-extinguisher recertification window opening at Vung Tau',
        source: 'public_data',
        confidenceLabel: 'low',
        verifiabilityNote:
          'Unverifiable — no CRM contact history and no confirmed prior service record for this vessel',
        detectedAt: new Date('2026-08-02T09:13:00.000Z'),
        status: 'needs_triage',
      },
    });

    await tx.tierHistoryEvent.create({
      data: {
        accountId: account.id,
        eventType: 'hold_at_tier',
        fromTier: 2,
        toTier: 2,
        reason:
          'Drafting call abstained — dossier too thin to draft anything credible (no confirmed ' +
          'relationship history for this trigger)',
      },
    });
  });
}

async function main() {
  // Loaded before importing '../client.js' — see import-triggers.ts's main() for why the
  // ordering matters.
  loadEnv({ path: path.join(import.meta.dirname, '../../../../.env') });
  const { prisma } = await import('../client.js');

  const result = await seedDemoData(prisma);

  console.log(
    result.seeded
      ? 'Seeded 4 demo accounts: Song Hong Shipping, Truong Phat Marine, Dai Duong Shipping, Vina Offshore Supply.'
      : 'Seed data already present — nothing written.',
  );

  await prisma.$disconnect();
}

// Only run when executed directly (not when imported by a test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error('Fatal error while seeding:', error);
    process.exit(1);
  });
}
