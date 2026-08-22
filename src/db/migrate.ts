import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

export function configureDatabase(sqlite: Database.Database) {
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
}

export function applyMigrations(sqlite: Database.Database, migrationsFolder = resolve(process.cwd(), 'drizzle')) {
  configureDatabase(sqlite);
  migrate(drizzle(sqlite), { migrationsFolder });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const databasePath = resolve(process.env.DATABASE_URL ?? './data/catalog.sqlite');
  mkdirSync(dirname(databasePath), { recursive: true });
  const sqlite = new Database(databasePath);
  applyMigrations(sqlite);
  sqlite.close();
}
