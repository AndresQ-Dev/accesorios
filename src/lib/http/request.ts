export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields?: Record<string, string>,
  ) { super(message); }
}

export function errorResponse(error: unknown, requestId: string) {
  const problem = error instanceof HttpError
    ? error
    : new HttpError(500, 'INTERNAL_ERROR', 'An unexpected server error occurred.');
  return Response.json({ error: {
    code: problem.code, message: problem.message, requestId, ...(problem.fields ? { fields: problem.fields } : {}),
  } }, { status: problem.status });
}

export async function readJson(request: Request) {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (!request.headers.get('content-type')?.includes('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Requests must use application/json.');
  }
  if (!Number.isFinite(length) || length > 4096) throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request body exceeds 4096 bytes.');
  const text = await request.text();
  if (text.length > 4096) throw new HttpError(413, 'REQUEST_TOO_LARGE', 'Request body exceeds 4096 bytes.');
  try { return JSON.parse(text) as unknown; } catch { throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.'); }
}
