import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestPostgres, stopTestPostgres, type TestPostgres } from '../test-utils/testcontainers-postgres.js';
import { importTriggersCsv } from './import-triggers.js';

const HEADER =
  'account_external_ref,account_company_name,account_segment,account_hub,account_icp_score,' +
  'account_icp_band,account_relationship_summary,vessel_name,vessel_imo,vessel_flag,' +
  'contact_name,contact_role,contact_email,trigger_category,trigger_description,trigger_source,' +
  'trigger_confidence_label,trigger_verifiability_note,trigger_detected_at';

function csvRow(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    account_external_ref: 'crm-001',
    account_company_name: 'Song Hong Shipping',
    account_segment: 'Offshore support vessel operator',
    account_hub: 'Haiphong',
    account_icp_score: '82',
    account_icp_band: 'high',
    account_relationship_summary: 'New account · first contact 12 Jul 2026',
    vessel_name: 'MV Song Hong Pioneer',
    vessel_imo: '9482137',
    vessel_flag: 'Vietnam',
    contact_name: 'Ms. Lan Pham',
    contact_role: 'Technical Superintendent',
    contact_email: 'lan.pham@example.com',
    trigger_category: 'life-raft service window',
    trigger_description: 'Life-raft servicing approaching next window',
    trigger_source: 'public_data',
    trigger_confidence_label: 'mid',
    trigger_verifiability_note: 'Partly verifiable',
    trigger_detected_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
  return HEADER.split(',')
    .map((column) => fields[column] ?? '')
    .join(',');
}

describe('importTriggersCsv', () => {
  let testDb: TestPostgres;

  beforeAll(async () => {
    testDb = await startTestPostgres();
  }, 60_000);

  afterAll(async () => {
    await stopTestPostgres(testDb);
  });

  it('creates the account, vessel, contact, and trigger from a valid row', async () => {
    const csv = `${HEADER}\n${csvRow()}\n`;

    const result = await importTriggersCsv(testDb.prisma, csv);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.summary).toEqual({ rowsImported: 1, triggersCreated: 1, triggersUpdated: 0 });

    const account = await testDb.prisma.account.findUniqueOrThrow({
      where: { externalRef: 'crm-001' },
      include: { vessels: true, contacts: true, triggers: true },
    });
    expect(account.companyName).toBe('Song Hong Shipping');
    expect(account.currentTier).toBe(2);
    expect(account.vessels).toHaveLength(1);
    expect(account.vessels[0].imo).toBe('9482137');
    expect(account.contacts).toHaveLength(1);
    expect(account.contacts[0].email).toBe('lan.pham@example.com');
    expect(account.triggers).toHaveLength(1);
    expect(account.triggers[0].status).toBe('new');
  });

  it('rejects the whole file and writes nothing when any row is invalid', async () => {
    const csv = `${HEADER}\n${csvRow({ account_external_ref: 'crm-002' })}\n${csvRow({
      account_external_ref: 'crm-003',
      account_company_name: '',
    })}\n`;

    const result = await importTriggersCsv(testDb.prisma, csv);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.errors).toContainEqual({
      row: 3,
      column: 'account_company_name',
      message: 'is required',
    });

    await expect(testDb.prisma.account.findUnique({ where: { externalRef: 'crm-002' } })).resolves.toBeNull();
    await expect(testDb.prisma.account.findUnique({ where: { externalRef: 'crm-003' } })).resolves.toBeNull();
  });

  it('rejects a file missing a required column', async () => {
    const csv = 'account_external_ref,account_company_name\ncrm-004,Acme\n';

    const result = await importTriggersCsv(testDb.prisma, csv);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.errors.some((e) => e.column === 'trigger_category')).toBe(true);
  });

  it('re-running the same file updates the account instead of duplicating it', async () => {
    const csv = `${HEADER}\n${csvRow({ account_external_ref: 'crm-005', account_company_name: 'Old Name' })}\n`;
    await importTriggersCsv(testDb.prisma, csv);

    const csv2 = `${HEADER}\n${csvRow({ account_external_ref: 'crm-005', account_company_name: 'New Name' })}\n`;
    const result = await importTriggersCsv(testDb.prisma, csv2);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    expect(result.summary.triggersUpdated).toBe(1);
    expect(result.summary.triggersCreated).toBe(0);

    const accounts = await testDb.prisma.account.findMany({ where: { externalRef: 'crm-005' } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0].companyName).toBe('New Name');

    const triggers = await testDb.prisma.trigger.findMany({ where: { accountId: accounts[0].id } });
    expect(triggers).toHaveLength(1);
  });

  it('imports a row with no vessel or contact columns', async () => {
    const csv = `${HEADER}\n${csvRow({
      account_external_ref: 'crm-006',
      vessel_name: '',
      vessel_imo: '',
      vessel_flag: '',
      contact_name: '',
      contact_role: '',
      contact_email: '',
    })}\n`;

    const result = await importTriggersCsv(testDb.prisma, csv);

    expect(result.ok).toBe(true);
    const account = await testDb.prisma.account.findUniqueOrThrow({
      where: { externalRef: 'crm-006' },
      include: { vessels: true, contacts: true },
    });
    expect(account.vessels).toHaveLength(0);
    expect(account.contacts).toHaveLength(0);
  });
});
