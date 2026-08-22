import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../../../lib/auth/admin';
import { editProduct } from '../../../../../lib/catalog/edits';
import { openCatalogDatabase } from '../../../../../lib/catalog/database';
import { errorResponse, HttpError } from '../../../../../lib/http/request';

export const PATCH: APIRoute = async ({ request, params }) => {
  const sqlite = openCatalogDatabase(); const requestId = crypto.randomUUID();
  try {
    const id = Number(params.id); if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'INVALID_PRODUCT_ID', 'Product ID must be a positive integer.');
    const product = await editProduct(sqlite, id, request, requireAdmin(sqlite, request));
    const { categoryId, categoryName, categoryActive, ...values } = product;
    return Response.json({ ...values, category: categoryId === null ? null : { id: categoryId, name: categoryName, active: categoryActive === 1 } });
  } catch (error) { return errorResponse(error, requestId); } finally { sqlite.close(); }
};
