import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { normalizeSearchText } from '../catalog/search';
import { getCatalogVersion } from '../catalog/version';
import { HttpError } from '../http/request';
import { XLSX_LIMITS, preflightXlsx } from './preflight';

const HEADERS = ['Código', 'C.Barras', 'Articulo', 'Stock fisico', 'Precio'];
const invalid = (message: string) => new HttpError(422, 'INVALID_XLSX', message);
export type PreviewRow = { code: string; barcode: string | null; article: string; stock: number | null; priceArs: number };
export type StoredPreview = { actorSessionHash: string; contentHash: string; baseCatalogVersion: number; expiresAt: number; rows: PreviewRow[] };
const previews = new Map<string, StoredPreview>();

function text(cell: ExcelJS.Cell, name: string, required = true) {
  if (cell.formula) throw invalid('Formulas are not allowed in XLSX imports.');
  const value = cell.value;
  if (value !== null && value !== undefined && typeof value !== 'string' && typeof value !== 'number') throw invalid(`${name} must be text or a number.`);
  const result = String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (result.length > XLSX_LIMITS.cellLength) throw invalid(`${name} exceeds the configured cell length.`);
  if (required && !result) throw invalid(`${name} is required.`);
  return result;
}

function whole(cell: ExcelJS.Cell, name: string, required = true) {
  const value = text(cell, name, required); if (!value && !required) return null;
  if (!/^\d+$/.test(value)) throw invalid(`${name} must be a non-negative whole number.`);
  const number = Number(value); if (!Number.isSafeInteger(number)) throw invalid(`${name} is outside the safe integer range.`);
  return number;
}

function parseRow(row: ExcelJS.Row): PreviewRow {
  const code = text(row.getCell(1), 'Código');
  const barcode = text(row.getCell(2), 'C.Barras', false) || null;
  if (barcode && /e[+-]?\d+$/i.test(barcode)) throw invalid('C.Barras must not use scientific notation.');
  return { code, barcode, article: text(row.getCell(3), 'Articulo'), stock: whole(row.getCell(4), 'Stock fisico', false), priceArs: whole(row.getCell(5), 'Precio')! };
}

export async function previewXlsx(sqlite: Database.Database, buffer: Buffer, actorSessionHash: string) {
  await preflightXlsx(buffer);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer as never); } catch { throw invalid('XLSX workbook could not be parsed.'); }
  if (workbook.worksheets.length !== XLSX_LIMITS.sheets) throw invalid('XLSX must contain exactly one worksheet.');
  const sheet = workbook.worksheets[0];
  if (sheet.rowCount < 2 || sheet.rowCount - 1 > XLSX_LIMITS.rows || sheet.columnCount > XLSX_LIMITS.columns) throw invalid('XLSX exceeds worksheet limits.');
  const receivedHeaders = HEADERS.map((_, index) => text(sheet.getRow(1).getCell(index + 1), `Header ${index + 1}`));
  if (receivedHeaders.some((header, index) => header !== HEADERS[index])) throw invalid('XLSX headers must exactly match the approved worksheet columns.');
  const rows: PreviewRow[] = []; const codes = new Set<string>(); const barcodes = new Set<string>();
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const row = parseRow(sheet.getRow(index)); const codeKey = normalizeSearchText(row.code); const barcodeKey = row.barcode && normalizeSearchText(row.barcode);
    if (codes.has(codeKey) || (barcodeKey && barcodes.has(barcodeKey))) throw invalid('XLSX contains duplicate normalized codes or barcodes.');
    codes.add(codeKey); if (barcodeKey) barcodes.add(barcodeKey); rows.push(row);
  }
  const existing = new Set((sqlite.prepare('SELECT code_key AS codeKey FROM products').all() as { codeKey: string }[]).map(({ codeKey }) => codeKey));
  const updates = rows.filter((row) => existing.has(normalizeSearchText(row.code))).length;
  const expiresAt = Date.now() + 10 * 60_000;
  const previewReference = crypto.randomUUID();
  const stored = { actorSessionHash, contentHash: createHash('sha256').update(buffer).digest('hex'), baseCatalogVersion: getCatalogVersion(sqlite), expiresAt, rows };
  previews.set(previewReference, stored);
  return { previewReference, contentHash: stored.contentHash, baseCatalogVersion: stored.baseCatalogVersion, diff: { creates: rows.length - updates, updates }, expiresAt: new Date(expiresAt).toISOString(), rows };
}

export function getPreview(previewReference: string, actorSessionHash: string) {
  const preview = previews.get(previewReference);
  if (!preview || preview.actorSessionHash !== actorSessionHash) throw new HttpError(409, 'PREVIEW_NOT_FOUND', 'The import preview is no longer available.');
  if (preview.expiresAt <= Date.now()) { previews.delete(previewReference); throw new HttpError(409, 'PREVIEW_EXPIRED', 'The import preview has expired.'); }
  return preview;
}

export function removePreview(previewReference: string) { previews.delete(previewReference); }
