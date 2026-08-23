import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '@node-rs/argon2';
import ExcelJS from 'exceljs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/db/migrate';
import { POST as login } from '../../src/pages/api/v1/admin/login';
import { POST as preview } from '../../src/pages/api/v1/admin/import/preview';

const headers = ['Código', 'C.Barras', 'Articulo', 'Stock fisico', 'Precio'];
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalPasswordHash = process.env.ADMIN_PASSWORD_HASH;
const directories: string[] = [];
let databasePath = ''; let password = '';

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'barcode-price-checker-xlsx-'));
  directories.push(directory); databasePath = join(directory, 'catalog.sqlite');
  const sqlite = new Database(databasePath); applyMigrations(sqlite, join(process.cwd(), 'drizzle'));
  sqlite.prepare('INSERT INTO products (code, code_key, barcode, article, article_key, price_ars, stock) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('EXISTING', 'existing', '111', 'Existing item', 'existing item', 100, 1);
  sqlite.close(); process.env.DATABASE_URL = databasePath; password = crypto.randomUUID();
  process.env.ADMIN_PASSWORD_HASH = await hash(password);
});

afterEach(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalPasswordHash === undefined) delete process.env.ADMIN_PASSWORD_HASH; else process.env.ADMIN_PASSWORD_HASH = originalPasswordHash;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function workbook(rows: unknown[][], firstRow = headers) {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Products'); sheet.addRow(firstRow);
  rows.forEach((row) => sheet.addRow(row)); return Buffer.from(await book.xlsx.writeBuffer());
}

async function session() {
  const response = await login({ request: new Request('http://local.test/api/v1/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://local.test' }, body: JSON.stringify({ password }) }) } as never);
  const { csrfToken } = await response.json() as { csrfToken: string };
  return { csrfToken, cookie: response.headers.get('set-cookie')?.match(/admin_session=([^;]+)/)?.[1] ?? '' };
}

async function upload(body: Buffer, credentials?: { cookie: string; csrfToken: string }) {
  const resolvedCredentials = credentials ?? await session();
  return preview({ request: new Request('http://local.test/api/v1/admin/import/preview', { method: 'POST', headers: { origin: 'http://local.test', cookie: `admin_session=${resolvedCredentials.cookie}`, 'x-csrf-token': resolvedCredentials.csrfToken, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: new Uint8Array(body) }) } as never);
}

describe('XLSX preview validation', () => {
  it('returns a non-mutating, hash-bound preview for a valid synthetic workbook', async () => {
    const response = await upload(await workbook([['EXISTING', '111', 'Updated item', 2, 125], ['NEW', '0123', 'New item', '', 250]]));
    expect(response.status).toBe(200);
    const payload = await response.json(); expect(payload.contentHash).toMatch(/^[a-f0-9]{64}$/); expect(Date.parse(payload.expiresAt)).toBeGreaterThan(Date.now());
    expect(payload).toMatchObject({ baseCatalogVersion: 1, diff: { creates: 1, updates: 1 }, rows: [
      { code: 'EXISTING', barcode: '111', article: 'Updated item', stock: 2, priceArs: 125 },
      { code: 'NEW', barcode: '0123', article: 'New item', stock: null, priceArs: 250 },
    ] });
    const sqlite = new Database(databasePath);
    expect(sqlite.prepare('SELECT code, price_ars AS priceArs, stock FROM products ORDER BY id').all()).toEqual([{ code: 'EXISTING', priceArs: 100, stock: 1 }]); sqlite.close();
  });

  it.each([
    ['wrong headers', ['Code', 'C.Barras', 'Articulo', 'Stock fisico', 'Precio'], [['A', '1', 'Item', 1, 1]]],
    ['duplicate headers', ['Código', 'Código', 'Articulo', 'Stock fisico', 'Precio'], [['A', '1', 'Item', 1, 1]]],
    ['duplicate normalized code', headers, [[' A ', '1', 'Item', 1, 1], ['a', '2', 'Other', 1, 2]]],
    ['duplicate barcode', headers, [['A', '1', 'Item', 1, 1], ['B', '1', 'Other', 1, 2]]],
    ['fractional price', headers, [['A', '1', 'Item', 1, 1.5]]],
    ['negative price', headers, [['A', '1', 'Item', 1, -1]]],
    ['malformed price', headers, [['A', '1', 'Item', 1, '1,000']]],
    ['scientific barcode', headers, [['A', '1E+12', 'Item', 1, 1]]],
    ['invalid stock', headers, [['A', '1', 'Item', -1, 1]]],
    ['overlong cell', headers, [['A', '1', 'x'.repeat(513), 1, 1]]],
    ['extra worksheet column', [...headers, 'Extra'], [['A', '1', 'Item', 1, 1, 'x']]],
  ])('rejects %s without catalog mutation', async (_caseName, firstRow, rows) => {
    const response = await upload(await workbook(rows, firstRow));
    expect(response.status).toBe(422); expect((await response.json()).error.code).toBe('INVALID_XLSX');
    const sqlite = new Database(databasePath); expect(sqlite.prepare('SELECT COUNT(*) AS count FROM products').get()).toEqual({ count: 1 }); sqlite.close();
  });

  it('rejects formula cells and unauthenticated or CSRF-less uploads', async () => {
    const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Products'); sheet.addRow(headers); sheet.addRow(['A', '1', 'Item', 1, { formula: '1+1', result: 2 }]);
    expect((await upload(Buffer.from(await book.xlsx.writeBuffer()))).status).toBe(422);
    const body = await workbook([['A', '1', 'Item', 1, 1]]);
    expect((await upload(body, { cookie: '', csrfToken: '' })).status).toBe(401);
    const authenticated = await session(); expect((await upload(body, { ...authenticated, csrfToken: '' })).status).toBe(403);
  });

  it('rejects a synthetic workbook with more than one worksheet', async () => {
    const book = new ExcelJS.Workbook(); ['Products', 'More products'].forEach((name) => { const sheet = book.addWorksheet(name); sheet.addRow(headers); sheet.addRow(['A', '1', 'Item', 1, 1]); });
    expect((await upload(Buffer.from(await book.xlsx.writeBuffer()))).status).toBe(422);
  });
});
