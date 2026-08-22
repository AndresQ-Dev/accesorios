import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { verify } from '@node-rs/argon2';
import { HttpError, readJson } from '../http/request';

const SESSION_SECONDS = 60 * 60 * 8;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function loginAdmin(sqlite: Database.Database, request: Request) {
  const payload = await readJson(request);
  if (!payload || typeof payload !== 'object' || typeof (payload as { password?: unknown }).password !== 'string') {
    throw new HttpError(400, 'INVALID_LOGIN', 'A password is required.', { password: 'Required' });
  }
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;
  if (!passwordHash?.startsWith('$argon2id$') || !await verify(passwordHash, (payload as { password: string }).password)) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid administrator credentials.');
  }
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000).toISOString();
  sqlite.prepare('INSERT INTO admin_sessions (token_hash, csrf_token, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), csrfToken, expiresAt);
  return Response.json({ csrfToken }, { headers: {
    'set-cookie': `admin_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_SECONDS}`,
  } });
}

export function requireAdmin(sqlite: Database.Database, request: Request) {
  const token = request.headers.get('cookie')?.match(/(?:^|;\s*)admin_session=([^;]+)/)?.[1];
  if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Administrator authentication is required.');
  const session = sqlite.prepare('SELECT token_hash AS tokenHash, csrf_token AS csrfToken FROM admin_sessions WHERE token_hash = ? AND expires_at > ?')
    .get(hashToken(token), new Date().toISOString()) as { tokenHash: string; csrfToken: string } | undefined;
  if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'Administrator authentication is required.');
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin) throw new HttpError(403, 'INVALID_ORIGIN', 'Request origin is not allowed.');
  const csrfToken = request.headers.get('x-csrf-token');
  if (!csrfToken || csrfToken.length !== session.csrfToken.length
    || !timingSafeEqual(Buffer.from(csrfToken), Buffer.from(session.csrfToken))) {
    throw new HttpError(403, 'INVALID_CSRF', 'CSRF token validation failed.');
  }
  return session.tokenHash;
}
