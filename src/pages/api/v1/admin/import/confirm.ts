import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../../../lib/auth/admin';
import { openCatalogDatabase } from '../../../../../lib/catalog/database';
import { errorResponse } from '../../../../../lib/http/request';
import { confirmXlsx } from '../../../../../lib/import/confirm';

export const POST: APIRoute = async ({ request }) => {
  const sqlite = openCatalogDatabase(); const requestId = crypto.randomUUID();
  try { return Response.json(await confirmXlsx(sqlite, request, requireAdmin(sqlite, request))); }
  catch (error) { return errorResponse(error, requestId); } finally { sqlite.close(); }
};
