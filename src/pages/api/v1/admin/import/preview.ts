import type { APIRoute } from 'astro';
import { requireAdmin } from '../../../../../lib/auth/admin';
import { openCatalogDatabase } from '../../../../../lib/catalog/database';
import { errorResponse } from '../../../../../lib/http/request';
import { readXlsxUpload } from '../../../../../lib/import/preflight';
import { previewXlsx } from '../../../../../lib/import/preview';

export const POST: APIRoute = async ({ request }) => {
  const sqlite = openCatalogDatabase(); const requestId = crypto.randomUUID();
  try { requireAdmin(sqlite, request); return Response.json(await previewXlsx(sqlite, await readXlsxUpload(request))); }
  catch (error) { return errorResponse(error, requestId); } finally { sqlite.close(); }
};
