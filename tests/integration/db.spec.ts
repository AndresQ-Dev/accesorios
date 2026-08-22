import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/db/migrate';

const temporaryDirectories: string[] = [];

function openMigratedDatabase() {
  const directory = `${tmpdir()}/barcode-price-checker-`;
  return mkdtemp(directory).then((path) => {
    temporaryDirectories.push(path);
    const sqlite = new Database(join(path, 'catalog.sqlite'));
    applyMigrations(sqlite, join(process.cwd(), 'drizzle'));
    return sqlite;
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('initial catalog migration', () => {
  it('creates the schema and enables the SQLite safety pragmas', async () => {
    const sqlite = await openMigratedDatabase();

    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
      .toEqual(expect.arrayContaining([{ name: 'categories' }, { name: 'products' }]));
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    sqlite.close();
  });

  it('enforces normalized category names and their active lifecycle values', async () => {
    const sqlite = await openMigratedDatabase();
    sqlite.prepare('INSERT INTO categories (name, name_key) VALUES (?, ?)').run('Helmets', 'helmets');

    expect(() => sqlite.prepare('INSERT INTO categories (name, name_key) VALUES (?, ?)')
      .run('HELMETS', 'helmets')).toThrow();
    expect(() => sqlite.prepare('INSERT INTO categories (name, name_key, active) VALUES (?, ?, ?)')
      .run('Invalid', 'invalid', 2)).toThrow();
    sqlite.close();
  });

  it('uses normalized code identity, nullable brand/category, and non-negative integer ARS prices', async () => {
    const sqlite = await openMigratedDatabase();
    const insertProduct = sqlite.prepare(`
      INSERT INTO products (code, code_key, brand, article, article_key, category_id, stock, price_ars)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertProduct.run('ZIB008', 'zib008', null, 'Helmet', 'helmet', null, 4, 59990);

    expect(sqlite.prepare('SELECT brand, category_id, price_ars FROM products').get())
      .toEqual({ brand: null, category_id: null, price_ars: 59990 });
    expect(() => insertProduct.run('ZIB008-2', 'zib008', null, 'Helmet', 'helmet', null, null, 1)).toThrow();
    expect(() => insertProduct.run('FREE', 'free', null, 'Helmet', 'helmet', null, null, -1)).toThrow();
    sqlite.close();
  });

  it('keeps references restricted and records product revision and timestamps', async () => {
    const sqlite = await openMigratedDatabase();
    const category = sqlite.prepare('INSERT INTO categories (name, name_key) VALUES (?, ?)').run('Helmets', 'helmets');
    sqlite.prepare(`
      INSERT INTO products (code, code_key, article, article_key, category_id, price_ars)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('ZIB008', 'zib008', 'Helmet', 'helmet', category.lastInsertRowid, 59990);

    const product = sqlite.prepare('SELECT id, revision, created_at, updated_at FROM products').get() as {
      id: number; revision: number; created_at: string; updated_at: string;
    };
    expect(product).toMatchObject({ revision: 1 });
    expect(product.created_at).toBeTruthy();
    expect(product.updated_at).toBeTruthy();
    expect(() => sqlite.prepare('DELETE FROM categories WHERE id = ?').run(category.lastInsertRowid)).toThrow();
    sqlite.close();
  });

  it('rolls back a failed transactional write without persisting its product', async () => {
    const sqlite = await openMigratedDatabase();
    sqlite.exec('BEGIN IMMEDIATE');
    sqlite.prepare(`INSERT INTO products (code, code_key, article, article_key, price_ars)
      VALUES (?, ?, ?, ?, ?)`).run('ROLLBACK', 'rollback', 'Helmet', 'helmet', 10);
    sqlite.exec('ROLLBACK');

    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM products WHERE code_key = ?').get('rollback'))
      .toEqual({ count: 0 });
    sqlite.close();
  });
});
