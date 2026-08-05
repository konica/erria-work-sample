import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@erria/db';
import { PRISMA } from '../prisma/prisma.module.js';

@Injectable()
export class AccountsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async getDetail(accountId: string) {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      include: {
        vessels: true,
        contacts: true,
        messages: { where: { status: 'pending_review' }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    if (!account) return null;

    const pendingMessage = account.messages[0] ?? null;

    return {
      account: {
        id: account.id,
        companyName: account.companyName,
        segment: account.segment,
        hub: account.hub,
        icpBand: account.icpBand,
        relationshipSummary: account.relationshipSummary,
        currentTier: account.currentTier,
        tierRationale: account.tierRationale,
      },
      vessels: account.vessels.map((v) => ({ id: v.id, name: v.name, imo: v.imo, flag: v.flag })),
      contacts: account.contacts.map((c) => ({ id: c.id, name: c.name, role: c.role, email: c.email })),
      pendingMessage: pendingMessage
        ? {
            id: pendingMessage.id,
            body: pendingMessage.body,
            edited: pendingMessage.edited,
            tierContext: pendingMessage.tierContext,
          }
        : null,
    };
  }

  /**
   * ADR-0004: Tier 1 is earned via Clean Approvals, never granted by hand — the caller (and the
   * DTO's @IsIn) must never pass 1, but the check stays here too since this is the invariant that
   * actually matters.
   */
  async changeTier(accountId: string, tier: number, reason: string) {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw new BadRequestException('A reason is required — it is saved to Tier History');
    }
    if (tier === 1) {
      throw new BadRequestException(
        'Tier 1 is earned through clean approvals and cannot be set manually',
      );
    }

    const account = await this.prisma.account.findUnique({ where: { id: accountId } });
    if (!account) {
      throw new NotFoundException(`Account ${accountId} not found`);
    }
    if (account.currentTier === tier) {
      throw new ConflictException(`Account ${accountId} is already Tier ${tier}`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.account.update({
        where: { id: accountId },
        data: {
          currentTier: tier,
          tierRationale: `Manually set to Tier ${tier} — ${trimmedReason}`,
        },
      });

      const event = await tx.tierHistoryEvent.create({
        data: {
          accountId,
          eventType: 'manual_override',
          fromTier: account.currentTier,
          toTier: tier,
          reason: `Tier ${account.currentTier} → Tier ${tier}. "${trimmedReason}" — manual override.`,
        },
      });

      return {
        account: { id: updated.id, currentTier: updated.currentTier },
        tierHistoryEvent: {
          id: event.id,
          eventType: event.eventType,
          fromTier: event.fromTier,
          toTier: event.toTier,
          reason: event.reason,
          occurredAt: event.occurredAt.toISOString(),
        },
      };
    });
  }
}
