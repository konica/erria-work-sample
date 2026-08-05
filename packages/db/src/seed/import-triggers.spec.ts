import { describe, it, expect } from 'vitest';
import { validateAndParseRows } from './import-triggers.js';

function validRecord(overrides: Record<string, string> = {}): Record<string, string> {
  return {
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
}

describe('validateAndParseRows', () => {
  it('parses a fully valid row with vessel and contact', () => {
    const { rows, errors } = validateAndParseRows([validRecord()]);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rowNumber: 2,
      account: { externalRef: 'crm-001', icpScore: 82, icpBand: 'high' },
      vessel: { name: 'MV Song Hong Pioneer', imo: '9482137', flag: 'Vietnam' },
      contact: { name: 'Ms. Lan Pham', role: 'Technical Superintendent', email: 'lan.pham@example.com' },
      trigger: { category: 'life-raft service window', source: 'public_data' },
    });
  });

  it('parses a row with no vessel or contact columns filled in', () => {
    const { rows, errors } = validateAndParseRows([
      validRecord({
        vessel_name: '',
        vessel_imo: '',
        vessel_flag: '',
        contact_name: '',
        contact_role: '',
        contact_email: '',
      }),
    ]);
    expect(errors).toEqual([]);
    expect(rows[0].vessel).toBeNull();
    expect(rows[0].contact).toBeNull();
  });

  it('reports a missing required column with its row and column name', () => {
    const { rows, errors } = validateAndParseRows([validRecord({ account_company_name: '' })]);
    expect(rows).toEqual([]);
    expect(errors).toContainEqual({ row: 2, column: 'account_company_name', message: 'is required' });
  });

  it('reports every invalid row, not just the first', () => {
    const { errors } = validateAndParseRows([
      validRecord({ account_company_name: '' }),
      validRecord({ trigger_category: '' }),
    ]);
    expect(errors).toContainEqual({ row: 2, column: 'account_company_name', message: 'is required' });
    expect(errors).toContainEqual({ row: 3, column: 'trigger_category', message: 'is required' });
  });

  it('rejects an out-of-range icp score', () => {
    const { errors } = validateAndParseRows([validRecord({ account_icp_score: '150' })]);
    expect(errors).toContainEqual({
      row: 2,
      column: 'account_icp_score',
      message: 'must be an integer between 0 and 100',
    });
  });

  it('rejects an unknown icp band', () => {
    const { errors } = validateAndParseRows([validRecord({ account_icp_band: 'medium' })]);
    expect(errors).toContainEqual({
      row: 2,
      column: 'account_icp_band',
      message: 'must be one of high, med, low',
    });
  });

  it('rejects an unknown trigger source', () => {
    const { errors } = validateAndParseRows([validRecord({ trigger_source: 'social_media' })]);
    expect(errors.some((e) => e.column === 'trigger_source')).toBe(true);
  });

  it('rejects an unparseable detected_at timestamp', () => {
    const { errors } = validateAndParseRows([validRecord({ trigger_detected_at: 'not-a-date' })]);
    expect(errors).toContainEqual({
      row: 2,
      column: 'trigger_detected_at',
      message: 'must be a valid ISO 8601 timestamp',
    });
  });

  it('rejects a partially-filled vessel group', () => {
    const { errors } = validateAndParseRows([validRecord({ vessel_imo: '' })]);
    expect(errors).toContainEqual({
      row: 2,
      column: 'vessel_imo',
      message: 'is required when any vessel_* column is set',
    });
  });

  it('rejects a partially-filled contact group', () => {
    const { errors } = validateAndParseRows([validRecord({ contact_role: '' })]);
    expect(errors).toContainEqual({
      row: 2,
      column: 'contact_role',
      message: 'is required when any contact_* column is set',
    });
  });

  it('allows contact_email to stay blank on an otherwise-complete contact', () => {
    const { rows, errors } = validateAndParseRows([validRecord({ contact_email: '' })]);
    expect(errors).toEqual([]);
    expect(rows[0].contact).toEqual({
      name: 'Ms. Lan Pham',
      role: 'Technical Superintendent',
      email: null,
    });
  });
});
