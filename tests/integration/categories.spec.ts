import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { hash } from '@node-rs/argon2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/db/migrate';
import { POST as login } from '../../src/pages/api/v1/admin/login';
import { GET as listCategoriesRoute, POST as addCategoryRoute } from '../../src/pages/api/v1/admin/categories/index';
import { PATCH as patchCategoryRoute } from '../../src/pages/api/v1/admin/categories/[id]';
import { PATCH as patchProduct } from '../../src/pages/api/v1/admin/products/[id]';

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAdminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
const directories: string[] = [];
let databasePath = '';
let password = '';

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'barcode-price-checker-categories-'));
  directories.push(directory);
  databasePath = join(directory, 'catalog.sqlite');
  const sqlite = new Database(databasePath);
  applyMigrations(sqlite, join(process.cwd(), 'drizzle'));
  sqlite.close();
  password = crypto.randomUUID();
  process.env.DATABASE_URL = databasePath;
  process.env.ADMIN_PASSWORD_HASH = await hash(password);
});

afterEach(async () => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalAdminPasswordHash === undefined) delete process.env.ADMIN_PASSWORD_HASH;
  else process.env.ADMIN_PASSWORD_HASH = originalAdminPasswordHash;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function seedReferencedCategory() {
  const sqlite = new Database(databasePath);
  applyMigrations(sqlite, join(process.cwd(), 'drizzle'));
  const category = sqlite.prepare('INSERT INTO categories (name, name_key) VALUES (?, ?)').run('Helmets', 'helmets');
  const product = sqlite.prepare(`INSERT INTO products (code, code_key, brand, article, article_key, category_id, price_ars)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run('CAT-001', 'cat-001', 'Brand', 'Helmet', 'helmet', category.lastInsertRowid, 100);
  sqlite.close();
  return { categoryId: Number(category.lastInsertRowid), productId: Number(product.lastInsertRowid) };
}

async function authenticate() {
  const response = await login({ request: new Request('http://local.test/api/v1/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://local.test' },
    body: JSON.stringify({ password }),
  }) } as never);
  const body = await response.json() as { csrfToken: string };
  return {
    csrfToken: body.csrfToken,
    cookie: response.headers.get('set-cookie')?.match(/admin_session=([^;]+)/)?.[1] ?? '',
  };
}

function listRequest(cookie: string, csrfToken: string, includeInactive?: string) {
  const query = includeInactive === undefined ? '' : `?includeInactive=${includeInactive}`;
  return listCategoriesRoute({ request: new Request(`http://local.test/api/v1/admin/categories${query}`, {
    method: 'GET',
    headers: { origin: 'http://local.test', cookie: `admin_session=${cookie}`, 'x-csrf-token': csrfToken },
  }) } as never);
}

function addRequest(cookie: string, csrfToken: string, body: unknown, origin = 'http://local.test') {
  return addCategoryRoute({ request: new Request('http://local.test/api/v1/admin/categories', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, cookie: `admin_session=${cookie}`, 'x-csrf-token': csrfToken },
    body: JSON.stringify(body),
  }) } as never);
}

function patchRequest(categoryId: number, cookie: string, csrfToken: string, body: unknown) {
  return patchCategoryRoute({ params: { id: String(categoryId) }, request: new Request(`http://local.test/api/v1/admin/categories/${categoryId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: 'http://local.test', cookie: `admin_session=${cookie}`, 'x-csrf-token': csrfToken },
    body: JSON.stringify(body),
  }) } as never);
}

function editProductRequest(productId: number, cookie: string, csrfToken: string, body: unknown) {
  return patchProduct({ params: { id: String(productId) }, request: new Request(`http://local.test/api/v1/admin/products/${productId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: 'http://local.test', cookie: `admin_session=${cookie}`, 'x-csrf-token': csrfToken },
    body: JSON.stringify(body),
  }) } as never);
}

function auditActions() {
  const sqlite = new Database(databasePath);
  const rows = sqlite.prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[];
  sqlite.close();
  return rows.map((row) => row.action);
}

describe('category lifecycle', () => {
  it('rejects unauthenticated and cross-origin category administration', async () => {
    expect((await listRequest('', '')).status).toBe(401);
    expect((await addRequest('', '', { name: 'Cascos' })).status).toBe(401);
    const session = await authenticate();
    expect((await addRequest(session.cookie, '', { name: 'Cascos' })).status).toBe(403);
    expect((await addRequest(session.cookie, session.csrfToken, { name: 'Cascos' }, 'https://other.test')).status).toBe(403);
  });

  it('adds a category and rejects empty or duplicate normalized names', async () => {
    const session = await authenticate();
    const created = await addRequest(session.cookie, session.csrfToken, { name: '  Cascos   Premium ' });
    expect(created.status).toBe(201);
    const category = await created.json() as { id: number; name: string; active: boolean };
    expect(category).toMatchObject({ name: 'Cascos Premium', active: true });

    for (const body of [{ name: 'cascos  premium' }, { name: '   ' }, { name: 42 }, {}]) {
      const rejected = await addRequest(session.cookie, session.csrfToken, body);
      expect(rejected.status).toBe(422);
    }
    const listing = await (await listRequest(session.cookie, session.csrfToken)).json() as { categories: { id: number }[] };
    expect(listing.categories).toHaveLength(1);
  });

  it('lists active categories by default and includes inactive on request', async () => {
    const sqlite = new Database(databasePath);
    sqlite.prepare('INSERT INTO categories (name, name_key, active, deactivated_at) VALUES (?, ?, 0, CURRENT_TIMESTAMP)')
      .run('Archive', 'archive');
    sqlite.close();
    const session = await authenticate();
    await addRequest(session.cookie, session.csrfToken, { name: 'Helmets' });

    const byDefault = await (await listRequest(session.cookie, session.csrfToken)).json() as { categories: { name: string }[] };
    expect(byDefault.categories.map((category) => category.name)).toEqual(['Helmets']);
    const included = await (await listRequest(session.cookie, session.csrfToken, 'true')).json() as { categories: { name: string }[] };
    expect(included.categories.map((category) => category.name).sort()).toEqual(['Archive', 'Helmets']);
    const excluded = await (await listRequest(session.cookie, session.csrfToken, 'false')).json() as { categories: { name: string }[] };
    expect(excluded.categories).toHaveLength(1);
  });

  it('renames a referenced category keeping assignments and audits the change', async () => {
    const { categoryId, productId } = seedReferencedCategory();
    const session = await authenticate();
    const response = await patchRequest(categoryId, session.cookie, session.csrfToken, { name: 'Accesorios' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: categoryId, name: 'Accesorios', active: true });

    const sqlite = new Database(databasePath);
    expect(sqlite.prepare('SELECT category_id AS categoryId FROM products WHERE id = ?').get(productId))
      .toEqual({ categoryId });
    sqlite.close();
    expect(auditActions()).toContain('category.renamed');

    await addRequest(session.cookie, session.csrfToken, { name: 'Cascos' });
    expect((await patchRequest(categoryId, session.cookie, session.csrfToken, { name: 'CASCOS' })).status).toBe(422);
  });

  it('deactivates and reactivates while preserving assignments', async () => {
    const { categoryId, productId } = seedReferencedCategory();
    const session = await authenticate();
    const deactivated = await patchRequest(categoryId, session.cookie, session.csrfToken, { active: false });
    expect(deactivated.status).toBe(200);
    const inactive = await deactivated.json() as { active: boolean; deactivatedAt: string | null };
    expect(inactive.active).toBe(false);
    expect(inactive.deactivatedAt).toBeTruthy();

    const sqlite = new Database(databasePath);
    expect(sqlite.prepare('SELECT category_id AS categoryId FROM products WHERE id = ?').get(productId))
      .toEqual({ categoryId });
    sqlite.close();

    const reactivated = await patchRequest(categoryId, session.cookie, session.csrfToken, { active: true });
    expect(await reactivated.json()).toMatchObject({ active: true, deactivatedAt: null });
    expect(auditActions()).toEqual(expect.arrayContaining(['category.deactivated', 'category.reactivated']));
  });

  it('rejects assigning an inactive category to a product', async () => {
    const { categoryId, productId } = seedReferencedCategory();
    const session = await authenticate();
    await patchRequest(categoryId, session.cookie, session.csrfToken, { active: false });
    const response = await editProductRequest(productId, session.cookie, session.csrfToken, {
      expectedRevision: 1, priceArs: 150, categoryId,
    });
    expect(response.status).toBe(422);
  });

  it('prevents deleting referenced categories at the database boundary', () => {
    const { categoryId } = seedReferencedCategory();
    const sqlite = new Database(databasePath);
    sqlite.pragma('foreign_keys = ON');
    expect(() => sqlite.prepare('DELETE FROM categories WHERE id = ?').run(categoryId)).toThrow(/FOREIGN KEY constraint failed/);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM categories').get()).toEqual({ count: 1 });
    sqlite.close();
  });

  it('persists an audit trail across the full lifecycle', async () => {
    const session = await authenticate();
    const created = await addRequest(session.cookie, session.csrfToken, { name: 'Cascos' });
    const category = await created.json() as { id: number };
    await patchRequest(category.id, session.cookie, session.csrfToken, { name: 'Accesorios' });
    await patchRequest(category.id, session.cookie, session.csrfToken, { active: false });
    await patchRequest(category.id, session.cookie, session.csrfToken, { active: true });
    expect(auditActions()).toEqual(['category.added', 'category.renamed', 'category.deactivated', 'category.reactivated']);
  });
});
