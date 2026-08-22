import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { configureDatabase } from '../../db/migrate';

export function openCatalogDatabase() {
  const databasePath = resolve(process.env.DATABASE_URL ?? './data/catalog.sqlite');
  const sqlite = new Database(databasePath);
  configureDatabase(sqlite);
  return sqlite;
}
