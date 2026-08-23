import type Database from 'better-sqlite3';

export function getCatalogVersion(sqlite: Database.Database) {
  return (sqlite.prepare(`SELECT MAX(COALESCE((SELECT catalog_version FROM catalog_metadata WHERE id = 1), 0),
    COALESCE((SELECT MAX(revision) FROM products), 0)) AS version`).get() as { version: number }).version;
}
