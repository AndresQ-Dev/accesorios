import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { registerBarcodeAlias } from '../../src/lib/catalog/aliases';
import { applyMigrations } from '../../src/db/migrate';
import { searchCatalog } from '../../src/lib/catalog/search';

const databases: Database.Database[] = [];

function openCatalog() {
  const sqlite = new Database(':memory:');
  applyMigrations(sqlite, `${process.cwd()}/drizzle`);
  databases.push(sqlite);
  return sqlite;
}

function insertProduct(
  sqlite: Database.Database,
  values: { code: string; barcode?: string | null; article: string },
) {
  sqlite.prepare(`
    INSERT INTO products (code, code_key, barcode, article, article_key, price_ars)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    values.code,
    values.code.toLowerCase(),
    values.barcode ?? null,
    values.article,
    values.article.toLowerCase(),
    100,
  );
}

afterEach(() => {
  databases.splice(0).forEach((sqlite) => sqlite.close());
});

describe('barcode aliases', () => {
  it('resolves the documented ITF scanner alias to its canonical barcode product', () => {
    const sqlite = openCatalog();
    insertProduct(sqlite, { code: 'ITF-001', barcode: '4440000015833', article: 'ITF product' });
    registerBarcodeAlias(sqlite, '04440000015833', '4440000015833');

    expect(searchCatalog(sqlite, '04440000015833').results.map(({ code }) => code)).toEqual(['ITF-001']);
  });

  it('does not infer an unregistered zero-prefixed value', () => {
    const sqlite = openCatalog();
    insertProduct(sqlite, { code: 'ITF-001', barcode: '4440000015833', article: 'ITF product' });
    registerBarcodeAlias(sqlite, '04440000015833', '4440000015833');

    expect(searchCatalog(sqlite, '004440000015833').results).toEqual([]);
  });

  it('rejects canonical and alias collisions without mutating aliases', () => {
    const sqlite = openCatalog();
    insertProduct(sqlite, { code: 'ITF-001', barcode: '4440000015833', article: 'ITF product' });
    insertProduct(sqlite, { code: 'OTHER-001', barcode: '9999999999999', article: 'Other product' });
    registerBarcodeAlias(sqlite, '04440000015833', '4440000015833');

    expect(() => registerBarcodeAlias(sqlite, '9999999999999', '4440000015833')).toThrow('canonical barcode');
    expect(() => registerBarcodeAlias(sqlite, '04440000015833', '9999999999999')).toThrow('already registered');
    expect(sqlite.prepare('SELECT alias, product_id AS productId FROM barcode_aliases').all()).toEqual([
      { alias: '04440000015833', productId: 1 },
    ]);
  });

  it('keeps barcode-less products searchable and never aliases them implicitly', () => {
    const sqlite = openCatalog();
    insertProduct(sqlite, { code: 'MANUAL-001', article: 'Product without barcode' });

    expect(() => registerBarcodeAlias(sqlite, '04440000015833', '4440000015833')).toThrow('does not exist');
    expect(searchCatalog(sqlite, 'manual-001').results.map(({ code }) => code)).toEqual(['MANUAL-001']);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM barcode_aliases').get()).toEqual({ count: 0 });
  });
});
