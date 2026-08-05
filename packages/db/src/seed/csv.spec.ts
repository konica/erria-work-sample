import { describe, it, expect } from 'vitest';
import { parseCsv, parseCsvRecords } from './csv.js';

describe('parseCsv', () => {
  it('parses a simple comma-delimited file', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles a file with no trailing newline', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a comma inside a quoted field intact', () => {
    expect(parseCsv('name,note\n"Song Hong Shipping","Offshore, support vessel operator"\n')).toEqual([
      ['name', 'note'],
      ['Song Hong Shipping', 'Offshore, support vessel operator'],
    ]);
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    expect(parseCsv('note\n"the buyer said ""yes"""\n')).toEqual([['note'], ['the buyer said "yes"']]);
  });

  it('keeps an embedded newline inside a quoted field as one row', () => {
    expect(parseCsv('note\n"line one\nline two"\n')).toEqual([['note'], ['line one\nline two']]);
  });

  it('drops a stray trailing blank line', () => {
    expect(parseCsv('a,b\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('parseCsvRecords', () => {
  it('maps rows onto trimmed header names', () => {
    const { headers, records } = parseCsvRecords(' name , role \nMs. Lan Pham,Technical Superintendent\n');
    expect(headers).toEqual(['name', 'role']);
    expect(records).toEqual([{ name: 'Ms. Lan Pham', role: 'Technical Superintendent' }]);
  });

  it('returns empty headers and records for an empty file', () => {
    expect(parseCsvRecords('')).toEqual({ headers: [], records: [] });
  });

  it('fills a missing trailing column with an empty string', () => {
    const { records } = parseCsvRecords('a,b,c\n1,2\n');
    expect(records).toEqual([{ a: '1', b: '2', c: '' }]);
  });
});
