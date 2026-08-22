import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { hash } from '@node-rs/argon2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/db/migrate';
import { POST as login } from '../../src/pages/api/v1/admin/login';
import { PATCH as patchProduct } from '../../src/pages/api/v1/admin/products/[id]';

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAdminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
const directories: string[] = [];
let databasePath = '';
let password = '';

beforeEach(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'barcode-price-checker-auth-'));
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

function seedProduct(categoryActive = 1) {
  const sqlite = new Database(databasePath);
  applyMigrations(sqlite, join(process.cwd(), 'drizzle'));
  const category = sqlite.prepare('INSERT INTO categories (name, name_key, active) VALUES (?, ?, ?)')
    .run('Helmets', 'helmets', categoryActive);
  const product = sqlite.prepare(`INSERT INTO products (code, code_key, brand, article, article_key, price_ars)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run('EDIT-001', 'edit-001', 'Original', 'Helmet', 'helmet', 100);
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
    response,
    csrfToken: body.csrfToken,
    cookie: response.headers.get('set-cookie')?.match(/admin_session=([^;]+)/)?.[1] ?? '',
  };
}

function editRequest(productId: number, cookie: string, csrfToken: string, body: unknown, origin = 'http://local.test') {
  return patchProduct({ params: { id: String(productId) }, request: new Request(`http://local.test/api/v1/admin/products/${productId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin, cookie: `admin_session=${cookie}`, 'x-csrf-token': csrfToken },
    body: JSON.stringify(body),
  }) } as never);
}

describe('authenticated product edits', () => {
  it('rejects unauthenticated, cross-origin, and missing-CSRF edits', async () => {
    const { productId } = seedProduct();
    expect((await editRequest(productId, '', '', { expectedRevision: 1, priceArs: 101 })).status).toBe(401);

    const session = await authenticate();
    expect((await editRequest(productId, session.cookie, session.csrfToken, { expectedRevision: 1, priceArs: 101 }, 'https://other.test')).status).toBe(403);
    expect((await editRequest(productId, session.cookie, '', { expectedRevision: 1, priceArs: 101 })).status).toBe(403);
  });

  it('authenticates from deployment configuration and audits a valid edit', async () => {
    const { productId } = seedProduct();
    const session = await authenticate();
    expect(session.response.status).toBe(200);
    expect(session.response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Strict');

    const response = await editRequest(productId, session.cookie, session.csrfToken, { expectedRevision: 1, priceArs: 125 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: productId, priceArs: 125, revision: 2 });

    const sqlite = new Database(databasePath);
    expect(sqlite.prepare('SELECT action, product_id AS productId FROM audit_log').all())
      .toEqual([{ action: 'product.updated', productId }]);
    sqlite.close();
  });

  it('returns a conflict without mutation when expectedRevision is stale', async () => {
    const { productId } = seedProduct();
    const session = await authenticate();
    await editRequest(productId, session.cookie, session.csrfToken, { expectedRevision: 1, priceArs: 125 });

    const response = await editRequest(productId, session.cookie, session.csrfToken, { expectedRevision: 1, priceArs: 250 });
    expect(response.status).toBe(409);
    const sqlite = new Database(databasePath);
    expect(sqlite.prepare('SELECT price_ars AS priceArs, revision FROM products WHERE id = ?').get(productId))
      .toEqual({ priceArs: 125, revision: 2 });
    sqlite.close();
  });

  it.each([100.5, -1])('rejects invalid integer priceArs values: %s', async (priceArs) => {
    const { productId } = seedProduct();
    const session = await authenticate();
    const response = await editRequest(productId, session.cookie, session.csrfToken, { expectedRevision: 1, priceArs });
    expect(response.status).toBe(422);
  });

  it('accepts nullable brand/category and only permits active categories', async () => {
    const { productId, categoryId } = seedProduct();
    const session = await authenticate();
    const response = await editRequest(productId, session.cookie, session.csrfToken, {
      expectedRevision: 1, priceArs: 125, brand: null, categoryId,
    });
    expect(await response.json()).toMatchObject({ brand: null, category: { id: categoryId, active: true } });

    const sqlite = new Database(databasePath);
    const inactive = sqlite.prepare('INSERT INTO categories (name, name_key, active) VALUES (?, ?, 0)')
      .run('Inactive', 'inactive');
    sqlite.close();
    const rejected = await editRequest(productId, session.cookie, session.csrfToken, {
      expectedRevision: 2, priceArs: 125, brand: null, categoryId: Number(inactive.lastInsertRowid),
    });
    expect(rejected.status).toBe(422);
  });
});
