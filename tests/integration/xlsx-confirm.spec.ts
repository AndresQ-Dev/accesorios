import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '@node-rs/argon2';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../src/db/migrate';
import { POST as login } from '../../src/pages/api/v1/admin/login';
import { POST as confirm } from '../../src/pages/api/v1/admin/import/confirm';
import { POST as preview } from '../../src/pages/api/v1/admin/import/preview';

const headers = ['Código', 'C.Barras', 'Articulo', 'Stock fisico', 'Precio'];
const original = { database: process.env.DATABASE_URL, password: process.env.ADMIN_PASSWORD_HASH, backups: process.env.BACKUP_DIRECTORY };
const directories: string[] = [];
let databasePath = ''; let password = '';

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'barcode-price-checker-confirm-'));
  directories.push(directory); databasePath = join(directory, 'catalog.sqlite');
  const sqlite = new Database(databasePath); applyMigrations(sqlite, join(process.cwd(), 'drizzle'));
  const category = sqlite.prepare('INSERT INTO categories (name, name_key) VALUES (?, ?)').run('Helmets', 'helmets');
  sqlite.prepare(`INSERT INTO products (code, code_key, barcode, brand, brand_key, article, article_key, category_id, stock, price_ars)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('EXISTING', 'existing', '111', 'Maintained', 'maintained', 'Old item', 'old item', category.lastInsertRowid, 1, 100);
  sqlite.prepare('INSERT INTO products (code, code_key, article, article_key, price_ars) VALUES (?, ?, ?, ?, ?)').run('ABSENT', 'absent', 'Absent item', 'absent item', 500);
  sqlite.close(); process.env.DATABASE_URL = databasePath; password = crypto.randomUUID(); process.env.ADMIN_PASSWORD_HASH = await hash(password);
});

afterEach(async () => {
  for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[{ database: 'DATABASE_URL', password: 'ADMIN_PASSWORD_HASH', backups: 'BACKUP_DIRECTORY' }[key] as string]; else process.env[{ database: 'DATABASE_URL', password: 'ADMIN_PASSWORD_HASH', backups: 'BACKUP_DIRECTORY' }[key] as string] = value;
  vi.useRealTimers(); await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function workbook(rows: unknown[][]) {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Products'); sheet.addRow(headers); rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await book.xlsx.writeBuffer());
}

async function credentials() {
  const response = await login({ request: new Request('http://local.test/api/v1/admin/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://local.test' }, body: JSON.stringify({ password }) }) } as never);
  const { csrfToken } = await response.json() as { csrfToken: string };
  return { csrfToken, cookie: response.headers.get('set-cookie')?.match(/admin_session=([^;]+)/)?.[1] ?? '' };
}

function request(url: string, credentials: { cookie: string; csrfToken: string }, body: BodyInit, type: string) {
  return new Request(url, { method: 'POST', headers: { origin: 'http://local.test', cookie: `admin_session=${credentials.cookie}`, 'x-csrf-token': credentials.csrfToken, 'content-type': type }, body });
}

async function createPreview(rows: unknown[][], session?: { cookie: string; csrfToken: string }) {
  const resolvedSession = session ?? await credentials();
  const body = await workbook(rows);
  const response = await preview({ request: request('http://local.test/api/v1/admin/import/preview', resolvedSession, new Uint8Array(body), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') } as never);
  return { session: resolvedSession, preview: await response.json() as { previewReference: string; contentHash: string; baseCatalogVersion: number } };
}

async function confirmPreview(session: { cookie: string; csrfToken: string }, body: unknown) {
  return confirm({ request: request('http://local.test/api/v1/admin/import/confirm', session, JSON.stringify(body), 'application/json') } as never);
}

function confirmationToken(preview: { previewReference: string; contentHash: string; baseCatalogVersion: number }) {
  return { previewReference: preview.previewReference, contentHash: preview.contentHash, baseCatalogVersion: preview.baseCatalogVersion };
}

function snapshot() {
  const sqlite = new Database(databasePath);
  const value = {
    products: sqlite.prepare('SELECT code, barcode, brand, category_id AS categoryId, stock, price_ars AS priceArs, revision FROM products ORDER BY code_key').all(),
    version: sqlite.prepare('SELECT catalog_version AS version FROM catalog_metadata').get(),
    runs: sqlite.prepare('SELECT COUNT(*) AS count FROM import_runs').get(), audit: sqlite.prepare('SELECT COUNT(*) AS count FROM audit_log').get(),
  }; sqlite.close(); return value;
}

describe('XLSX confirm transaction', () => {
  it('confirms only its opaque preview, backs up, and atomically upserts by normalized code', async () => {
    const { session, preview: token } = await createPreview([[' existing ', '111', 'Updated item', 3, 125], ['NEW', '222', 'New item', 4, 250]]);
    const confirmation = confirmationToken(token); expect((await confirmPreview(session, { ...confirmation, rows: [] })).status).toBe(422);
    const response = await confirmPreview(session, confirmation); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ catalogVersion: 2, creates: 1, updates: 1 });
    const state = snapshot(); expect(state.products).toEqual([
      { code: 'ABSENT', barcode: null, brand: null, categoryId: null, stock: null, priceArs: 500, revision: 1 },
      { code: 'existing', barcode: '111', brand: 'Maintained', categoryId: 1, stock: 3, priceArs: 125, revision: 2 },
      { code: 'NEW', barcode: '222', brand: null, categoryId: null, stock: 4, priceArs: 250, revision: 1 },
    ]); expect(state).toMatchObject({ version: { version: 2 }, runs: { count: 1 }, audit: { count: 1 } });
  });

  it.each(['wrong hash', 'stale base version', 'expired'])('rejects %s without catalog metadata or audit mutation', async (caseName) => {
    if (caseName === 'expired') vi.useFakeTimers({ shouldAdvanceTime: true });
    const { session, preview: token } = await createPreview([['NEW', '222', 'New item', 4, 250]]);
    if (caseName === 'expired') vi.setSystemTime(Date.now() + 11 * 60_000);
    const confirmation = confirmationToken(token);
    const body = caseName === 'wrong hash' ? { ...confirmation, contentHash: '0'.repeat(64) } : caseName === 'stale base version' ? { ...confirmation, baseCatalogVersion: token.baseCatalogVersion + 1 } : confirmation;
    const before = snapshot(); expect((await confirmPreview(session, body)).status).toBe(409); expect(snapshot()).toEqual(before);
  });

  it('rejects canonical/alias collisions, revision changes, backup failure, and a write error without partial state', async () => {
    const sqlite = new Database(databasePath); sqlite.prepare('INSERT INTO barcode_aliases (alias, product_id) VALUES (?, ?)').run('alias-111', 1); sqlite.close();
    let pending = await createPreview([['NEW', 'alias-111', 'New item', 4, 250]]); let before = snapshot(); expect((await confirmPreview(pending.session, confirmationToken(pending.preview))).status).toBe(409); expect(snapshot()).toEqual(before);
    pending = await createPreview([['EXISTING', '111', 'Updated item', 3, 125]]); const revisionWriter = new Database(databasePath); revisionWriter.prepare('UPDATE products SET revision = 2 WHERE code_key = ?').run('existing'); revisionWriter.close(); before = snapshot(); expect((await confirmPreview(pending.session, confirmationToken(pending.preview))).status).toBe(409); expect(snapshot()).toEqual(before);
    const blocker = join(directories[0], 'backup-blocker'); await writeFile(blocker, 'x'); process.env.BACKUP_DIRECTORY = blocker;
    pending = await createPreview([['NEW', '222', 'New item', 4, 250]]); before = snapshot(); expect((await confirmPreview(pending.session, confirmationToken(pending.preview))).status).toBe(500); expect(snapshot()).toEqual(before); delete process.env.BACKUP_DIRECTORY;
    const writer = new Database(databasePath); writer.exec("CREATE TRIGGER import_failure BEFORE INSERT ON products WHEN NEW.code_key = 'explode' BEGIN SELECT RAISE(ABORT, 'forced'); END"); writer.close();
    pending = await createPreview([['FIRST', '222', 'First', 1, 1], ['EXPLODE', '333', 'Explode', 1, 2]]); before = snapshot(); expect((await confirmPreview(pending.session, confirmationToken(pending.preview))).status).toBe(500); expect(snapshot()).toEqual(before);
  });
});
