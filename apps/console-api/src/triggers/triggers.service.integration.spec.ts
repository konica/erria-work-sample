import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type Anthropic from '@anthropic-ai/sdk';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '@erria/db/test-utils';
import { buildServer } from '../../../worker/src/server.js';
import { PRISMA } from '../prisma/prisma.module.js';
import { WorkerClient } from '../worker-client/worker-client.service.js';
import { TriggersService } from './triggers.service.js';

describe('TriggersService', () => {
  let testDb: TestPostgres;
  let workerUrl: string;

  beforeAll(async () => {
    testDb = await startTestPostgres();

    const anthropic = {
      messages: {
        parse: vi.fn().mockResolvedValue({
          parsed_output: {
            should_draft: true,
            draft_text: 'Hi Ms. Pham, ...',
            confidence_label: 'high',
            abstain_reason: null,
          },
          usage: { input_tokens: 500, output_tokens: 120 },
        }),
      },
    } as unknown as Anthropic;

    const workerServer = buildServer({ prisma: testDb.prisma, anthropic });
    workerUrl = await workerServer.listen({ port: 0, host: '127.0.0.1' });
    process.env.WORKER_INTERNAL_URL = workerUrl;
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  it('upserts a new account at Tier 2, persists the trigger, and drafts via the worker', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [TriggersService, WorkerClient, { provide: PRISMA, useValue: testDb.prisma }],
    }).compile();
    const service = moduleRef.get(TriggersService);

    const result = await service.receiveTrigger({
      account: {
        externalRef: 'crm-acc-001',
        companyName: 'Song Hong Shipping',
        segment: 'Offshore support vessel operator',
        hub: 'Haiphong',
        icpScore: 90,
        icpBand: 'high',
        relationshipSummary: 'New account · first contact 12 Jul 2026',
      },
      vessel: { name: 'MV Song Hong Pioneer', imo: '9123456', flag: 'Vietnam' },
      category: 'life-raft service window',
      description: 'Life raft may be approaching its next scheduled service window',
      source: 'public_data',
      confidenceLabel: 'mid',
      verifiabilityNote: 'Partly verifiable — service interval is illustrative',
      detectedAt: new Date().toISOString(),
      hasComplianceDeadlineContent: false,
    });

    expect(result.triggerId).toBeDefined();

    const account = await testDb.prisma.account.findUniqueOrThrow({
      where: { externalRef: 'crm-acc-001' },
    });
    expect(account.currentTier).toBe(2);

    const createEvent = await testDb.prisma.tierHistoryEvent.findFirstOrThrow({
      where: { accountId: account.id, eventType: 'create' },
    });
    expect(createEvent.toTier).toBe(2);

    const vessel = await testDb.prisma.vessel.findUniqueOrThrow({ where: { imo: '9123456' } });
    expect(vessel.accountId).toBe(account.id);

    const message = await testDb.prisma.message.findFirstOrThrow({
      where: { accountId: account.id },
    });
    expect(message.status).toBe('pending_review');
  });

  it('updates an existing account in place instead of duplicating it', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [TriggersService, WorkerClient, { provide: PRISMA, useValue: testDb.prisma }],
    }).compile();
    const service = moduleRef.get(TriggersService);

    const existing = await testDb.prisma.account.create({
      data: {
        externalRef: 'crm-acc-002',
        companyName: 'Old Name Shipping',
        segment: 'Old segment',
        hub: 'Old hub',
        icpScore: 50,
        icpBand: 'low',
        relationshipSummary: 'Old summary',
        currentTier: 2,
        tierRationale: 'Existing account',
      },
    });

    await service.receiveTrigger({
      account: {
        externalRef: 'crm-acc-002',
        companyName: 'New Name Shipping',
        segment: 'New segment',
        hub: 'New hub',
        icpScore: 80,
        icpBand: 'high',
        relationshipSummary: 'Updated summary',
      },
      category: 'life-raft service window',
      description: 'Updated trigger',
      source: 'crm',
      confidenceLabel: 'high',
      verifiabilityNote: 'Verified via CRM',
      detectedAt: new Date().toISOString(),
      hasComplianceDeadlineContent: false,
    });

    const accounts = await testDb.prisma.account.findMany({
      where: { externalRef: 'crm-acc-002' },
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe(existing.id);
    expect(accounts[0].companyName).toBe('New Name Shipping');
  });

  it('upserts the contact so the account has a recipient for dispatch', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [TriggersService, WorkerClient, { provide: PRISMA, useValue: testDb.prisma }],
    }).compile();
    const service = moduleRef.get(TriggersService);

    await service.receiveTrigger({
      account: {
        externalRef: 'crm-acc-contact-001',
        companyName: 'Vinh Long Coastal',
        segment: 'Coastal freight operator',
        hub: 'Haiphong',
        icpScore: 60,
        icpBand: 'med',
        relationshipSummary: 'New account',
      },
      contact: { name: 'Ms. Lan Pham', role: 'Technical Superintendent', email: 'lan.pham@example.com' },
      category: 'life-raft service window',
      description: 'test',
      source: 'public_data',
      confidenceLabel: 'mid',
      verifiabilityNote: 'test',
      detectedAt: new Date().toISOString(),
      hasComplianceDeadlineContent: false,
    });

    const account = await testDb.prisma.account.findUniqueOrThrow({
      where: { externalRef: 'crm-acc-contact-001' },
      include: { contacts: true },
    });
    expect(account.contacts).toHaveLength(1);
    expect(account.contacts[0].email).toBe('lan.pham@example.com');

    // A second trigger for the same contact updates rather than duplicating.
    await service.receiveTrigger({
      account: {
        externalRef: 'crm-acc-contact-001',
        companyName: 'Vinh Long Coastal',
        segment: 'Coastal freight operator',
        hub: 'Haiphong',
        icpScore: 60,
        icpBand: 'med',
        relationshipSummary: 'New account',
      },
      contact: { name: 'Ms. Lan Pham', role: 'Chief Engineer', email: 'lan.pham@example.com' },
      category: 'EPIRB battery expiry',
      description: 'test',
      source: 'public_data',
      confidenceLabel: 'mid',
      verifiabilityNote: 'test',
      detectedAt: new Date().toISOString(),
      hasComplianceDeadlineContent: false,
    });

    const refreshed = await testDb.prisma.account.findUniqueOrThrow({
      where: { externalRef: 'crm-acc-contact-001' },
      include: { contacts: true },
    });
    expect(refreshed.contacts).toHaveLength(1);
    expect(refreshed.contacts[0].role).toBe('Chief Engineer');
  });
});
