import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../../../lib/auth/admin';
import { addCategory, listCategories } from '../../../../../lib/catalog/categories';
import { openCatalogDatabase } from '../../../../../lib/catalog/database';
import { errorResponse } from '../../../../../lib/http/request';

export const GET: APIRoute = async ({ request }) => {
  const sqlite = openCatalogDatabase(); const requestId = crypto.randomUUID();
  try {
    requireAdmin(sqlite, request);
    const includeInactive = ['true', '1'].includes(new URL(request.url).searchParams.get('includeInactive') ?? '');
    return Response.json({ categories: listCategories(sqlite, includeInactive) });
  } catch (error) { return errorResponse(error, requestId); } finally { sqlite.close(); }
};

export const POST: APIRoute = async ({ request }) => {
  const sqlite = openCatalogDatabase(); const requestId = crypto.randomUUID();
  try {
    const category = await addCategory(sqlite, request, requireAdmin(sqlite, request));
    return Response.json(category, { status: 201 });
  } catch (error) { return errorResponse(error, requestId); } finally { sqlite.close(); }
};
