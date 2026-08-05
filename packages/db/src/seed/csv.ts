/**
 * Minimal RFC4180 CSV parsing — quoted fields, embedded commas/newlines, and `""` as an escaped
 * quote. No external dependency: the column set this repo needs is simple, but real spreadsheet
 * exports (Excel, Google Sheets) do quote fields containing commas, so a naive `split(',')` would
 * silently corrupt rows rather than failing loudly.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < len) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      pushField();
      i++;
      continue;
    }
    if (ch === '\r') {
      i++; // swallow; the following `\n` (or EOF) ends the row
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // The file may or may not end with a trailing newline — flush whatever's pending either way.
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  // Drop fully blank lines (a lone empty field from a stray trailing newline or blank row).
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

export interface CsvRecords {
  headers: string[];
  records: Record<string, string>[];
}

/** Parses `text` and maps every row after the first onto the first row's (trimmed) headers. */
export function parseCsvRecords(text: string): CsvRecords {
  const rows = parseCsv(text);
  const headerRow = rows[0];
  if (!headerRow) {
    return { headers: [], records: [] };
  }

  const headers = headerRow.map((h) => h.trim());
  const records = rows.slice(1).map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, (row[index] ?? '').trim()])),
  );

  return { headers, records };
}
