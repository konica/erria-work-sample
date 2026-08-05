import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config as loadEnv } from 'dotenv';
import type { PrismaClient } from '../generated/prisma/client.js';
import { upsertAccount, upsertContact, upsertVessel } from './upsert-entities.js';
import { parseCsvRecords } from './csv.js';

// See docs/csv-import.md for the full column contract this validates against.
const REQUIRED_COLUMNS = [
  'account_external_ref',
  'account_company_name',
  'account_segment',
  'account_hub',
  'account_icp_score',
  'account_icp_band',
  'account_relationship_summary',
  'trigger_category',
  'trigger_description',
  'trigger_source',
  'trigger_confidence_label',
  'trigger_verifiability_note',
  'trigger_detected_at',
] as const;

const ICP_BANDS = new Set(['high', 'med', 'low']);
const TRIGGER_SOURCES = new Set(['crm', 'class_records', 'public_data', 'buyer_reply']);
const CONFIDENCE_LABELS = new Set(['high', 'mid', 'low']);

export interface ImportRowError {
  row: number;
  column: string;
  message: string;
}

export interface ParsedTriggerRow {
  rowNumber: number;
  account: {
    externalRef: string;
    companyName: string;
    segment: string;
    hub: string;
    icpScore: number;
    icpBand: 'high' | 'med' | 'low';
    relationshipSummary: string;
  };
  vessel: { name: string; imo: string; flag: string } | null;
  contact: { name: string; role: string; email: string | null } | null;
  trigger: {
    category: string;
    description: string;
    source: 'crm' | 'class_records' | 'public_data' | 'buyer_reply';
    confidenceLabel: 'high' | 'mid' | 'low';
    verifiabilityNote: string;
    detectedAt: Date;
  };
}

function validateRow(
  record: Record<string, string>,
  rowNumber: number,
): { row: ParsedTriggerRow | null; errors: ImportRowError[] } {
  const errors: ImportRowError[] = [];

  const require = (column: string): string => {
    const value = record[column] ?? '';
    if (!value) errors.push({ row: rowNumber, column, message: 'is required' });
    return value;
  };

  const externalRef = require('account_external_ref');
  const companyName = require('account_company_name');
  const segment = require('account_segment');
  const hub = require('account_hub');
  const icpScoreRaw = require('account_icp_score');
  const icpBandRaw = require('account_icp_band');
  const relationshipSummary = require('account_relationship_summary');
  const category = require('trigger_category');
  const description = require('trigger_description');
  const sourceRaw = require('trigger_source');
  const confidenceLabelRaw = require('trigger_confidence_label');
  const verifiabilityNote = require('trigger_verifiability_note');
  const detectedAtRaw = require('trigger_detected_at');

  let icpScore = NaN;
  if (icpScoreRaw) {
    icpScore = Number(icpScoreRaw);
    if (!Number.isInteger(icpScore) || icpScore < 0 || icpScore > 100) {
      errors.push({
        row: rowNumber,
        column: 'account_icp_score',
        message: 'must be an integer between 0 and 100',
      });
    }
  }

  if (icpBandRaw && !ICP_BANDS.has(icpBandRaw)) {
    errors.push({ row: rowNumber, column: 'account_icp_band', message: 'must be one of high, med, low' });
  }

  if (sourceRaw && !TRIGGER_SOURCES.has(sourceRaw)) {
    errors.push({
      row: rowNumber,
      column: 'trigger_source',
      message: 'must be one of crm, class_records, public_data, buyer_reply',
    });
  }

  if (confidenceLabelRaw && !CONFIDENCE_LABELS.has(confidenceLabelRaw)) {
    errors.push({
      row: rowNumber,
      column: 'trigger_confidence_label',
      message: 'must be one of high, mid, low',
    });
  }

  let detectedAt: Date | null = null;
  if (detectedAtRaw) {
    const parsed = new Date(detectedAtRaw);
    if (Number.isNaN(parsed.getTime())) {
      errors.push({
        row: rowNumber,
        column: 'trigger_detected_at',
        message: 'must be a valid ISO 8601 timestamp',
      });
    } else {
      detectedAt = parsed;
    }
  }

  // Vessel and Contact are optional per row, but partially-filled-in groups are rejected rather
  // than silently dropped — a typo'd `vessel_imo` header should not quietly produce a Trigger
  // with no vessel rather than an error.
  const vesselName = record.vessel_name ?? '';
  const vesselImo = record.vessel_imo ?? '';
  const vesselFlag = record.vessel_flag ?? '';
  const hasAnyVesselField = Boolean(vesselName || vesselImo || vesselFlag);
  let vessel: ParsedTriggerRow['vessel'] = null;
  if (hasAnyVesselField) {
    if (!vesselName) {
      errors.push({ row: rowNumber, column: 'vessel_name', message: 'is required when any vessel_* column is set' });
    }
    if (!vesselImo) {
      errors.push({ row: rowNumber, column: 'vessel_imo', message: 'is required when any vessel_* column is set' });
    }
    if (!vesselFlag) {
      errors.push({ row: rowNumber, column: 'vessel_flag', message: 'is required when any vessel_* column is set' });
    }
    if (vesselName && vesselImo && vesselFlag) {
      vessel = { name: vesselName, imo: vesselImo, flag: vesselFlag };
    }
  }

  const contactName = record.contact_name ?? '';
  const contactRole = record.contact_role ?? '';
  const contactEmail = record.contact_email ?? '';
  const hasAnyContactField = Boolean(contactName || contactRole || contactEmail);
  let contact: ParsedTriggerRow['contact'] = null;
  if (hasAnyContactField) {
    if (!contactName) {
      errors.push({ row: rowNumber, column: 'contact_name', message: 'is required when any contact_* column is set' });
    }
    if (!contactRole) {
      errors.push({ row: rowNumber, column: 'contact_role', message: 'is required when any contact_* column is set' });
    }
    if (contactName && contactRole) {
      contact = { name: contactName, role: contactRole, email: contactEmail || null };
    }
  }

  if (errors.length > 0) {
    return { row: null, errors };
  }

  return {
    row: {
      rowNumber,
      account: {
        externalRef,
        companyName,
        segment,
        hub,
        icpScore,
        icpBand: icpBandRaw as 'high' | 'med' | 'low',
        relationshipSummary,
      },
      vessel,
      contact,
      trigger: {
        category,
        description,
        source: sourceRaw as 'crm' | 'class_records' | 'public_data' | 'buyer_reply',
        confidenceLabel: confidenceLabelRaw as 'high' | 'mid' | 'low',
        verifiabilityNote,
        detectedAt: detectedAt as Date,
      },
    },
    errors: [],
  };
}

/** Validates every record and reports every error found — never stops at the first bad row. */
export function validateAndParseRows(records: Record<string, string>[]): {
  rows: ParsedTriggerRow[];
  errors: ImportRowError[];
} {
  const rows: ParsedTriggerRow[] = [];
  const errors: ImportRowError[] = [];

  records.forEach((record, index) => {
    const rowNumber = index + 2; // row 1 is the header
    const result = validateRow(record, rowNumber);
    if (result.row) rows.push(result.row);
    errors.push(...result.errors);
  });

  return { rows, errors };
}

export interface ImportSummary {
  rowsImported: number;
  triggersCreated: number;
  triggersUpdated: number;
}

export type ImportResult = { ok: true; summary: ImportSummary } | { ok: false; errors: ImportRowError[] };

/**
 * Imports Accounts/Vessels/Contacts/Triggers from CSV text (column contract:
 * docs/csv-import.md). Every row is validated before anything is written — if any row is
 * invalid, the whole file is rejected and nothing is written. Each valid row's writes land in one
 * transaction and are idempotent on natural keys (`Account.externalRef`, `Vessel.imo`, and
 * `(accountId, category, detectedAt)` for Trigger), so re-running the same file updates in place
 * rather than duplicating.
 *
 * Deliberately does not invoke drafting — a Trigger this creates lands at `status: 'new'`, same as
 * one freshly received and not yet processed. Feeding it into the drafting pipeline (the same
 * worker call `POST /internal/triggers` makes) is a separate step; see docs/csv-import.md for why.
 */
export async function importTriggersCsv(client: PrismaClient, csvText: string): Promise<ImportResult> {
  const { headers, records } = parseCsvRecords(csvText);

  const missingColumns = REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
  if (missingColumns.length > 0) {
    return {
      ok: false,
      errors: missingColumns.map((column) => ({ row: 1, column, message: 'missing required column' })),
    };
  }

  const { rows, errors } = validateAndParseRows(records);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  let triggersCreated = 0;
  let triggersUpdated = 0;

  for (const row of rows) {
    await client.$transaction(async (tx) => {
      const account = await upsertAccount(tx, row.account);
      const vessel = row.vessel ? await upsertVessel(tx, account.id, row.vessel) : null;
      if (row.contact) {
        await upsertContact(tx, account.id, row.contact);
      }

      const existingTrigger = await tx.trigger.findFirst({
        where: {
          accountId: account.id,
          category: row.trigger.category,
          detectedAt: row.trigger.detectedAt,
        },
      });

      if (existingTrigger) {
        await tx.trigger.update({
          where: { id: existingTrigger.id },
          data: {
            vesselId: vessel?.id ?? null,
            description: row.trigger.description,
            source: row.trigger.source,
            confidenceLabel: row.trigger.confidenceLabel,
            verifiabilityNote: row.trigger.verifiabilityNote,
          },
        });
        triggersUpdated++;
      } else {
        await tx.trigger.create({
          data: {
            accountId: account.id,
            vesselId: vessel?.id ?? null,
            category: row.trigger.category,
            description: row.trigger.description,
            source: row.trigger.source,
            confidenceLabel: row.trigger.confidenceLabel,
            verifiabilityNote: row.trigger.verifiabilityNote,
            detectedAt: row.trigger.detectedAt,
          },
        });
        triggersCreated++;
      }
    });
  }

  return { ok: true, summary: { rowsImported: rows.length, triggersCreated, triggersUpdated } };
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: pnpm --filter @erria/db run import:triggers <file.csv>');
    process.exit(1);
  }

  // Loaded before importing '../client.js', which builds its PrismaClient from
  // process.env.DATABASE_URL at module-evaluation time — after that module loads, setting the
  // env var here would be too late. Does not override an already-exported DATABASE_URL.
  loadEnv({ path: path.join(import.meta.dirname, '../../../../.env') });
  const { prisma } = await import('../client.js');

  let csvText: string;
  try {
    csvText = await readFile(filePath, 'utf8');
  } catch (error) {
    console.error(`Could not read ${filePath}: ${(error as Error).message}`);
    process.exit(1);
    return;
  }

  const result = await importTriggersCsv(prisma, csvText);

  if (!result.ok) {
    console.error(`${result.errors.length} invalid row(s) — nothing was imported:`);
    for (const error of result.errors) {
      console.error(`  Row ${error.row}, column "${error.column}": ${error.message}`);
    }
    await prisma.$disconnect();
    process.exit(1);
    return;
  }

  console.log(
    `Imported ${result.summary.rowsImported} row(s): ` +
      `${result.summary.triggersCreated} trigger(s) created, ${result.summary.triggersUpdated} updated.`,
  );
  await prisma.$disconnect();
}

// Only run when executed directly (not when imported by a test).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error('Fatal error during CSV import:', error);
    process.exit(1);
  });
}
