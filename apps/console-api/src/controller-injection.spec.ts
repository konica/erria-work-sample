import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueueController } from './queue/queue.controller.js';
import { QueueService } from './queue/queue.service.js';
import { AccountsController } from './accounts/accounts.controller.js';
import { AccountsService } from './accounts/accounts.service.js';
import { TriggersController } from './triggers/triggers.controller.js';
import { TriggersService } from './triggers/triggers.service.js';
import { NavCountsController } from './nav-counts/nav-counts.controller.js';
import { NavCountsService } from './nav-counts/nav-counts.service.js';
import { AuditController } from './audit/audit.controller.js';
import { AuditService } from './audit/audit.service.js';
import { InboundController } from './inbound/inbound.controller.js';
import { InboundService } from './inbound/inbound.service.js';

// Regression guard for #35.
//
// Controllers use *implicit* constructor injection (`private readonly x: XService`,
// with no @Inject token), which Nest can only resolve from the `design:paramtypes`
// metadata a decorator-metadata-aware compiler emits. Runners that transform via
// esbuild — `tsx`, and Vitest without unplugin-swc — silently omit it, so the
// dependency arrives as `undefined`. Nothing fails at boot: the app starts and logs
// its mapped routes, then every request dies on `Cannot read properties of undefined`.
//
// Resolving the controller through the Nest container and calling the handler is what
// makes that regression visible. Tests that instantiate services directly cannot see
// it, which is why the original endpoint tests passed while the app was broken.
//
// Note the services themselves use explicit `@Inject(PRISMA)` and were never affected;
// it is specifically the controllers' implicit injection that depends on metadata.
describe('controller constructor injection (regression guard for #35)', () => {
  it('injects QueueService into QueueController', async () => {
    const page = { items: [], total: 0, page: 1, pageSize: 20 };
    const list = vi.fn().mockResolvedValue(page);

    const moduleRef = await Test.createTestingModule({
      controllers: [QueueController],
      providers: [{ provide: QueueService, useValue: { list } }],
    }).compile();

    const controller = moduleRef.get(QueueController);

    // Throws `Cannot read properties of undefined (reading 'list')` when metadata is missing.
    await expect(controller.list()).resolves.toEqual(page);
    expect(list).toHaveBeenCalledWith({ tier: undefined, page: 1 });
  });

  it('passes parsed query parameters through to QueueService', async () => {
    const list = vi.fn().mockResolvedValue({ items: [], total: 0, page: 2, pageSize: 20 });

    const moduleRef = await Test.createTestingModule({
      controllers: [QueueController],
      providers: [{ provide: QueueService, useValue: { list } }],
    }).compile();

    await moduleRef.get(QueueController).list('2', '3');

    expect(list).toHaveBeenCalledWith({ tier: 2, page: 3 });
  });

  it('injects AccountsService into AccountsController', async () => {
    const getDetail = vi.fn().mockResolvedValue({ accountId: 'acc-1' });

    const moduleRef = await Test.createTestingModule({
      controllers: [AccountsController],
      providers: [{ provide: AccountsService, useValue: { getDetail } }],
    }).compile();

    await expect(moduleRef.get(AccountsController).detail('acc-1')).resolves.toEqual({
      accountId: 'acc-1',
    });
    expect(getDetail).toHaveBeenCalledWith('acc-1');
  });

  it('translates a missing account into 404 rather than returning null', async () => {
    const getDetail = vi.fn().mockResolvedValue(null);

    const moduleRef = await Test.createTestingModule({
      controllers: [AccountsController],
      providers: [{ provide: AccountsService, useValue: { getDetail } }],
    }).compile();

    await expect(moduleRef.get(AccountsController).detail('missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('injects TriggersService into TriggersController', async () => {
    const receiveTrigger = vi.fn().mockResolvedValue({ triggerId: 'trigger-1' });

    const moduleRef = await Test.createTestingModule({
      controllers: [TriggersController],
      providers: [{ provide: TriggersService, useValue: { receiveTrigger } }],
    }).compile();

    const dto = { account: { externalRef: 'crm-acc-001' } } as never;
    await expect(moduleRef.get(TriggersController).receive(dto)).resolves.toEqual({
      triggerId: 'trigger-1',
    });
    expect(receiveTrigger).toHaveBeenCalledWith(dto);
  });

  it('injects NavCountsService into NavCountsController', async () => {
    const get = vi.fn().mockResolvedValue({ review: 3, escalation: 1 });

    const moduleRef = await Test.createTestingModule({
      controllers: [NavCountsController],
      providers: [{ provide: NavCountsService, useValue: { get } }],
    }).compile();

    await expect(moduleRef.get(NavCountsController).get()).resolves.toEqual({
      review: 3,
      escalation: 1,
    });
    expect(get).toHaveBeenCalled();
  });

  it('injects AuditService into AuditController', async () => {
    const page = { items: [], total: 0, page: 1, pageSize: 20 };
    const list = vi.fn().mockResolvedValue(page);

    const moduleRef = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [{ provide: AuditService, useValue: { list } }],
    }).compile();

    // Throws `Cannot read properties of undefined (reading 'list')` when metadata is missing.
    await expect(moduleRef.get(AuditController).list()).resolves.toEqual(page);
  });

  it('passes the mark verdict and the authenticated reviewer through to AuditService', async () => {
    const mark = vi.fn().mockResolvedValue({
      auditSample: { id: 'aud_1', reviewStatus: 'concerning', reviewedBy: 'Minh Tran', reviewedAt: new Date() },
    });

    const moduleRef = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [{ provide: AuditService, useValue: { mark } }],
    }).compile();

    await moduleRef
      .get(AuditController)
      .mark('aud_1', { verdict: 'concerning' }, { sub: 'u1', name: 'Minh Tran', roles: [] });

    expect(mark).toHaveBeenCalledWith('aud_1', 'concerning', 'Minh Tran');
  });

  it('injects InboundService into InboundController', async () => {
    const receiveInbound = vi.fn().mockResolvedValue({ messageId: 'msg-1', escalated: false });

    const moduleRef = await Test.createTestingModule({
      controllers: [InboundController],
      providers: [{ provide: InboundService, useValue: { receiveInbound } }],
    }).compile();

    const dto = { accountId: 'acc-1', body: 'hello', receivedAt: new Date().toISOString() } as never;
    // Throws `Cannot read properties of undefined (reading 'receiveInbound')` when metadata is missing.
    await expect(moduleRef.get(InboundController).receive(dto)).resolves.toEqual({
      messageId: 'msg-1',
      escalated: false,
    });
    expect(receiveInbound).toHaveBeenCalledWith(dto);
  });
});
