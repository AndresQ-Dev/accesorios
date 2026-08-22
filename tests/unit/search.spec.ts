import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
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
  values: {
    code: string;
    barcode?: string | null;
    brand?: string | null;
    article: string;
    categoryId?: number | null;
    priceArs: number;
    stock?: number | null;
    revision?: number;
  },
) {
  sqlite.prepare(`
    INSERT INTO products
      (code, code_key, barcode, brand, brand_key, article, article_key, category_id, price_ars, stock, revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.code,
    values.code.toLowerCase(),
    values.barcode ?? null,
    values.brand ?? null,
    values.brand?.toLowerCase() ?? null,
    values.article,
    values.article.toLowerCase(),
    values.categoryId ?? null,
    values.priceArs,
    values.stock ?? null,
    values.revision ?? 1,
  );
}

afterEach(() => {
  databases.splice(0).forEach((sqlite) => sqlite.close());
});

describe('catalog search', () => {
  it('ranks canonical barcode, exact code, and code prefix before descriptive matches', () => {
    const sqlite = openCatalog();
    insertProduct(sqlite, { code: 'DESC-100', barcode: 'scan-123', brand: 'Scan', article: '123 helmet', priceArs: 1 });
    insertProduct(sqlite, { code: 'scan-123', brand: 'Road', article: 'Touring helmet', priceArs: 2 });
    insertProduct(sqlite, { code: 'scan-123-pro', brand: 'Road', article: 'Touring helmet', priceArs: 3 });
    insertProduct(sqlite, { code: 'MANUAL', brand: 'scan-123', article: 'Road helmet', priceArs: 4 });

    expect(searchCatalog(sqlite, 'scan-123').results.map(({ code }) => code)).toEqual([
      'DESC-100',
      'scan-123',
      'scan-123-pro',
      'MANUAL',
    ]);
  });

  it('uses all-token prefix matching before descriptive substring matching', () => {
    const sqlite = openCatalog();
    const category = sqlite.prepare('INSERT INTO categories (name, name_key) VALUES (?, ?)').run('Helmets', 'helmets');
    insertProduct(sqlite, { code: 'PREFIX', brand: 'Road', article: 'Touring helmet', categoryId: Number(category.lastInsertRowid), priceArs: 1 });
    insertProduct(sqlite, { code: 'SUBSTRING', brand: 'Offroad', article: 'Daily helmet', categoryId: Number(category.lastInsertRowid), priceArs: 2 });

    expect(searchCatalog(sqlite, 'ro hel').results.map(({ code }) => code)).toEqual(['PREFIX', 'SUBSTRING']);
  });

  it('returns display labels, integer prices, freshness metadata, and never stock', () => {
    const sqlite = openCatalog();
    insertProduct(sqlite, {
      code: 'MANUAL-ONLY',
      article: 'Helmet without barcode',
      priceArs: 59990,
      stock: 12,
      revision: 4,
    });

    const response = searchCatalog(sqlite, 'manual');

    expect(response.results).toEqual([{
      id: 1,
      code: 'MANUAL-ONLY',
      brand: 'Sin definir',
      article: 'Helmet without barcode',
      category: 'Sin definir',
      priceArs: 59990,
    }]);
    expect(response.catalogVersion).toBe(4);
    expect(response.freshness).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(response.results[0]).not.toHaveProperty('stock');
  });
});
