import type { APIRoute } from 'astro';
import { openCatalogDatabase } from '../../../lib/catalog/database';
import { normalizeSearchText, searchCatalog } from '../../../lib/catalog/search';

function invalidQueryResponse(requestId: string) {
  return Response.json({
    error: {
      code: 'INVALID_QUERY',
      message: 'The q query parameter must not be empty.',
      requestId,
      fields: { q: 'Required' },
    },
  }, { status: 400 });
}

export const GET: APIRoute = ({ url }) => {
  const requestId = crypto.randomUUID();
  const query = url.searchParams.get('q');

  if (query === null || normalizeSearchText(query) === '') return invalidQueryResponse(requestId);

  const sqlite = openCatalogDatabase();
  try {
    return Response.json(searchCatalog(sqlite, query));
  } finally {
    sqlite.close();
  }
};
