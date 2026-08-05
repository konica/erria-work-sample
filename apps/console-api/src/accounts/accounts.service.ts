import { Inject, Injectable } from '@nestjs/common';
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

  async tierHistory(accountId: string) {
    const events = await this.prisma.tierHistoryEvent.findMany({
      where: { accountId },
      orderBy: { occurredAt: 'desc' },
    });

    return {
      items: events.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        fromTier: event.fromTier,
        toTier: event.toTier,
        reason: event.reason,
        occurredAt: event.occurredAt.toISOString(),
        // The console tags human overrides distinctly so a reviewer scanning the timeline can
        // tell system-driven from human-driven entries at a glance.
        isManual: event.eventType === 'manual_override',
      })),
    };
  }
}
