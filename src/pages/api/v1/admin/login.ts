import type { APIRoute } from 'astro';
import { loginAdmin } from '../../../../lib/auth/admin';
import { openCatalogDatabase } from '../../../../lib/catalog/database';
import { errorResponse } from '../../../../lib/http/request';

export const POST: APIRoute = async ({ request }) => {
  const sqlite = openCatalogDatabase(); const requestId = crypto.randomUUID();
  try { return await loginAdmin(sqlite, request); } catch (error) { return errorResponse(error, requestId); } finally { sqlite.close(); }
};
