CREATE TABLE catalog_metadata (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  catalog_version INTEGER NOT NULL CHECK (catalog_version >= 0)
);
--> statement-breakpoint
INSERT INTO catalog_metadata (id, catalog_version) VALUES (1, (SELECT COALESCE(MAX(revision), 0) FROM products));
--> statement-breakpoint
CREATE TABLE import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  actor_session_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  base_catalog_version INTEGER NOT NULL,
  catalog_version INTEGER NOT NULL,
  row_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
