import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { normalizeSearchText } from '../catalog/search';
import { getCatalogVersion } from '../catalog/version';
import { HttpError, readJson } from '../http/request';
import { getPreview, removePreview } from './preview';

type Confirmation = { previewReference: string; contentHash: string; baseCatalogVersion: number };

async function parseConfirmation(request: Request): Promise<Confirmation> {
  const payload = await readJson(request);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(422, 'INVALID_CONFIRMATION', 'Import confirmation is invalid.');
  const confirmation = payload as Record<string, unknown>;
  if (Object.keys(confirmation).some((key) => !['previewReference', 'contentHash', 'baseCatalogVersion'].includes(key))
    || typeof confirmation.previewReference !== 'string' || typeof confirmation.contentHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(confirmation.contentHash) || !Number.isInteger(confirmation.baseCatalogVersion)) {
    throw new HttpError(422, 'INVALID_CONFIRMATION', 'Import confirmation is invalid.');
  }
  return confirmation as Confirmation;
}

async function createBackup(sqlite: Database.Database) {
  const databasePath = resolve(process.env.DATABASE_URL ?? './data/catalog.sqlite');
  const directory = resolve(process.env.BACKUP_DIRECTORY ?? join(dirname(databasePath), 'backups'));
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `catalog-import-${Date.now()}-${randomUUID()}.sqlite`);
  await sqlite.backup(path);
  writeFileSync(`${path}.sha256`, `${createHash('sha256').update(readFileSync(path)).digest('hex')}\n`, { flag: 'wx' });
}

function assertBarcodeCollisions(sqlite: Database.Database, rows: ReturnType<typeof getPreview>['rows']) {
  const products = sqlite.prepare('SELECT id, code_key AS codeKey, barcode FROM products').all() as { id: number; codeKey: string; barcode: string | null }[];
  const aliases = sqlite.prepare('SELECT alias, product_id AS productId FROM barcode_aliases').all() as { alias: string; productId: number }[];
  for (const row of rows) {
    if (!row.barcode) continue;
    const codeKey = normalizeSearchText(row.code); const barcodeKey = normalizeSearchText(row.barcode);
    const canonical = products.find((product) => product.barcode !== null && normalizeSearchText(product.barcode) === barcodeKey);
    if (canonical && canonical.codeKey !== codeKey) throw new HttpError(409, 'BARCODE_COLLISION', 'An imported barcode belongs to another product.');
    if (aliases.some((alias) => normalizeSearchText(alias.alias) === barcodeKey)) {
      throw new HttpError(409, 'BARCODE_COLLISION', 'An imported barcode collides with a registered alias.');
    }
  }
}

export async function confirmXlsx(sqlite: Database.Database, request: Request, actorSessionHash: string) {
  const confirmation = await parseConfirmation(request);
  const preview = getPreview(confirmation.previewReference, actorSessionHash);
  if (confirmation.contentHash !== preview.contentHash || confirmation.baseCatalogVersion !== preview.baseCatalogVersion) {
    throw new HttpError(409, 'PREVIEW_MISMATCH', 'The import confirmation does not match its preview.');
  }
  if (getCatalogVersion(sqlite) !== preview.baseCatalogVersion) throw new HttpError(409, 'REVISION_CONFLICT', 'The catalog changed after preview.');
  await createBackup(sqlite);
  const result = sqlite.transaction(() => {
    if (getCatalogVersion(sqlite) !== preview.baseCatalogVersion) throw new HttpError(409, 'REVISION_CONFLICT', 'The catalog changed after preview.');
    assertBarcodeCollisions(sqlite, preview.rows);
    let creates = 0; let updates = 0;
    const existing = sqlite.prepare('SELECT id FROM products WHERE code_key = ?');
    const update = sqlite.prepare(`UPDATE products SET code = ?, barcode = ?, article = ?, article_key = ?, stock = ?, price_ars = ?,
      revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
    const insert = sqlite.prepare(`INSERT INTO products (code, code_key, barcode, brand, brand_key, article, article_key, category_id, stock, price_ars)
      VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)`);
    for (const row of preview.rows) {
      const codeKey = normalizeSearchText(row.code); const product = existing.get(codeKey) as { id: number } | undefined;
      if (product) { update.run(row.code, row.barcode, row.article, normalizeSearchText(row.article), row.stock, row.priceArs, product.id); updates += 1; }
      else { insert.run(row.code, codeKey, row.barcode, row.article, normalizeSearchText(row.article), row.stock, row.priceArs); creates += 1; }
    }
    const catalogVersion = preview.baseCatalogVersion + 1;
    sqlite.prepare('UPDATE catalog_metadata SET catalog_version = ? WHERE id = 1').run(catalogVersion);
    sqlite.prepare(`INSERT INTO import_runs (actor_session_hash, content_hash, base_catalog_version, catalog_version, row_count)
      VALUES (?, ?, ?, ?, ?)`).run(actorSessionHash, preview.contentHash, preview.baseCatalogVersion, catalogVersion, preview.rows.length);
    sqlite.prepare('INSERT INTO audit_log (actor_session_hash, action, details) VALUES (?, ?, ?)')
      .run(actorSessionHash, 'import.confirmed', JSON.stringify({ creates, updates, catalogVersion }));
    return { catalogVersion, creates, updates };
  });
  const response = result.immediate();
  removePreview(confirmation.previewReference);
  return response;
}
