import type Database from 'better-sqlite3';
import { HttpError, readJson } from '../http/request';

type Edit = { expectedRevision: number; priceArs: number; brand?: string | null; categoryId?: number | null };

async function parseEdit(request: Request): Promise<Edit> {
  const payload = await readJson(request);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(422, 'INVALID_EDIT', 'Product edit is invalid.');
  const edit = payload as Record<string, unknown>;
  if (Object.keys(edit).some((key) => !['expectedRevision', 'priceArs', 'brand', 'categoryId'].includes(key))
    || !Number.isInteger(edit.expectedRevision) || !Number.isInteger(edit.priceArs) || (edit.priceArs as number) < 0
    || (edit.brand !== undefined && edit.brand !== null && (typeof edit.brand !== 'string' || edit.brand.trim() === ''))
    || (edit.categoryId !== undefined && edit.categoryId !== null && !Number.isInteger(edit.categoryId))) {
    throw new HttpError(422, 'INVALID_EDIT', 'Product edit is invalid.');
  }
  return edit as Edit;
}

export async function editProduct(sqlite: Database.Database, productId: number, request: Request, actorSessionHash: string) {
  const edit = await parseEdit(request);
  return sqlite.transaction(() => {
    const current = sqlite.prepare('SELECT brand, category_id AS categoryId FROM products WHERE id = ?').get(productId) as { brand: string | null; categoryId: number | null } | undefined;
    if (!current) throw new HttpError(404, 'PRODUCT_NOT_FOUND', 'Product does not exist.');
    const brand = edit.brand === undefined ? current.brand : edit.brand === null ? null : edit.brand.trim();
    const categoryId = edit.categoryId === undefined ? current.categoryId : edit.categoryId;
    if (edit.categoryId !== undefined && categoryId !== null && !sqlite.prepare('SELECT 1 FROM categories WHERE id = ? AND active = 1').get(categoryId)) {
      throw new HttpError(422, 'INVALID_CATEGORY', 'Category must exist and be active.', { categoryId: 'Must reference an active category' });
    }
    const change = sqlite.prepare(`UPDATE products SET brand = ?, brand_key = ?, category_id = ?, price_ars = ?,
      revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND revision = ?`)
      .run(brand, brand?.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es-AR') ?? null, categoryId, edit.priceArs, productId, edit.expectedRevision);
    if (!change.changes) throw new HttpError(409, 'REVISION_CONFLICT', 'Product changed before this edit could be applied.');
    sqlite.prepare('INSERT INTO audit_log (actor_session_hash, action, product_id, details) VALUES (?, ?, ?, ?)')
      .run(actorSessionHash, 'product.updated', productId, JSON.stringify({ expectedRevision: edit.expectedRevision }));
    return sqlite.prepare(`SELECT products.id, products.code, products.brand, products.article, products.price_ars AS priceArs,
      products.revision, categories.id AS categoryId, categories.name AS categoryName, categories.active AS categoryActive
      FROM products LEFT JOIN categories ON categories.id = products.category_id WHERE products.id = ?`).get(productId) as {
        id: number; code: string; brand: string | null; article: string; priceArs: number; revision: number;
        categoryId: number | null; categoryName: string | null; categoryActive: number | null;
      };
  })();
}
