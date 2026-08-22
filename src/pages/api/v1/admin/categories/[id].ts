import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../../../lib/auth/admin';
import { patchCategory } from '../../../../../lib/catalog/categories';
import { openCatalogDatabase } from '../../../../../lib/catalog/database';
import { errorResponse, HttpError } from '../../../../../lib/http/request';

export const PATCH: APIRoute = async ({ request, params }) => {
  const sqlite = openCatalogDatabase(); const requestId = crypto.randomUUID();
  try {
    const id = Number(params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError(400, 'INVALID_CATEGORY_ID', 'Category ID must be a positive integer.');
    return Response.json(await patchCategory(sqlite, id, request, requireAdmin(sqlite, request)));
  } catch (error) { return errorResponse(error, requestId); } finally { sqlite.close(); }
};
