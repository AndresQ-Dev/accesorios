import type Database from 'better-sqlite3';
import { HttpError, readJson } from '../http/request';
import { normalizeSearchText } from './search';

export type CategoryView = { id: number; name: string; active: boolean; deactivatedAt: string | null };

type CategoryRow = { id: number; name: string; nameKey: string; active: number; deactivatedAt: string | null };

const CATEGORY_SELECT = 'SELECT id, name, name_key AS nameKey, active, deactivated_at AS deactivatedAt FROM categories';
const AUDIT_INSERT = 'INSERT INTO audit_log (actor_session_hash, action, details) VALUES (?, ?, ?)';

function toView(row: CategoryRow): CategoryView {
  return { id: row.id, name: row.name, active: row.active === 1, deactivatedAt: row.deactivatedAt };
}

function displayText(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function parseName(raw: unknown) {
  if (typeof raw !== 'string') throw new HttpError(422, 'INVALID_CATEGORY', 'Category name must be a string.', { name: 'Required' });
  const nameKey = normalizeSearchText(raw);
  if (!nameKey) throw new HttpError(422, 'INVALID_CATEGORY', 'Category name cannot be empty.', { name: 'Required' });
  return { display: displayText(raw), nameKey };
}

function findDuplicateNameKey(sqlite: Database.Database, nameKey: string, excludeCategoryId?: number) {
  return sqlite.prepare('SELECT 1 FROM categories WHERE name_key = ? AND id != ?')
    .get(nameKey, excludeCategoryId ?? -1);
}

export function listCategories(sqlite: Database.Database, includeInactive: boolean): CategoryView[] {
  const rows = sqlite.prepare(`${CATEGORY_SELECT} ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY name_key`).all() as CategoryRow[];
  return rows.map(toView);
}

export async function addCategory(sqlite: Database.Database, request: Request, actorSessionHash: string): Promise<CategoryView> {
  const payload = await readJson(request);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(422, 'INVALID_CATEGORY', 'Category payload is invalid.');
  }
  const { display, nameKey } = parseName((payload as Record<string, unknown>).name);
  return sqlite.transaction(() => {
    if (findDuplicateNameKey(sqlite, nameKey)) {
      throw new HttpError(422, 'DUPLICATE_CATEGORY_NAME', 'A category with this name already exists.', { name: 'Already exists' });
    }
    const inserted = sqlite.prepare('INSERT INTO categories (name, name_key) VALUES (?, ?)').run(display, nameKey);
    const id = Number(inserted.lastInsertRowid);
    sqlite.prepare(AUDIT_INSERT).run(actorSessionHash, 'category.added', JSON.stringify({ categoryId: id, name: display }));
    return toView(sqlite.prepare(`${CATEGORY_SELECT} WHERE id = ?`).get(id) as CategoryRow);
  })();
}

export async function patchCategory(sqlite: Database.Database, categoryId: number, request: Request, actorSessionHash: string): Promise<CategoryView> {
  const payload = await readJson(request);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(422, 'INVALID_CATEGORY_EDIT', 'Category edit is invalid.');
  }
  const edit = payload as Record<string, unknown>;
  const keys = Object.keys(edit);
  if (keys.length === 0 || keys.some((key) => !['name', 'active'].includes(key))
    || (edit.name !== undefined && typeof edit.name !== 'string')
    || (edit.active !== undefined && typeof edit.active !== 'boolean')) {
    throw new HttpError(422, 'INVALID_CATEGORY_EDIT', 'Category edit is invalid.');
  }
  return sqlite.transaction(() => {
    const current = sqlite.prepare(`${CATEGORY_SELECT} WHERE id = ?`).get(categoryId) as CategoryRow | undefined;
    if (!current) throw new HttpError(404, 'CATEGORY_NOT_FOUND', 'Category does not exist.');
    let name = current.name;
    let nameKey = current.nameKey;
    if (edit.name !== undefined) {
      ({ display: name, nameKey } = parseName(edit.name));
      if (nameKey !== current.nameKey && findDuplicateNameKey(sqlite, nameKey, categoryId)) {
        throw new HttpError(422, 'DUPLICATE_CATEGORY_NAME', 'A category with this name already exists.', { name: 'Already exists' });
      }
    }
    const active = edit.active === undefined ? current.active : edit.active ? 1 : 0;
    if (name === current.name && nameKey === current.nameKey && active === current.active) return toView(current);
    sqlite.prepare(`UPDATE categories SET name = ?, name_key = ?, active = ?,
      deactivated_at = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(deactivated_at, CURRENT_TIMESTAMP) END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(name, nameKey, active, active, categoryId);
    if (name !== current.name || nameKey !== current.nameKey) {
      sqlite.prepare(AUDIT_INSERT).run(actorSessionHash, 'category.renamed', JSON.stringify({ categoryId, from: current.name, to: name }));
    }
    if (active !== current.active) {
      sqlite.prepare(AUDIT_INSERT).run(actorSessionHash, active === 1 ? 'category.reactivated' : 'category.deactivated',
        JSON.stringify({ categoryId }));
    }
    return toView(sqlite.prepare(`${CATEGORY_SELECT} WHERE id = ?`).get(categoryId) as CategoryRow);
  })();
}
