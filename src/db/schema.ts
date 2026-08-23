import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const categories = sqliteTable('categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  nameKey: text('name_key').notNull(),
  active: integer('active').notNull().default(1),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
  deactivatedAt: text('deactivated_at'),
}, (table) => [
  uniqueIndex('categories_name_key_unique').on(table.nameKey),
]);

export const products = sqliteTable('products', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull(),
  codeKey: text('code_key').notNull(),
  barcode: text('barcode'),
  brand: text('brand'),
  brandKey: text('brand_key'),
  article: text('article').notNull(),
  articleKey: text('article_key').notNull(),
  categoryId: integer('category_id').references(() => categories.id, { onDelete: 'restrict' }),
  stock: integer('stock'),
  priceArs: integer('price_ars').notNull(),
  revision: integer('revision').notNull().default(1),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
}, (table) => [
  uniqueIndex('products_code_key_unique').on(table.codeKey),
  uniqueIndex('products_barcode_unique').on(table.barcode),
  index('products_article_key_index').on(table.articleKey),
  index('products_brand_key_index').on(table.brandKey),
  index('products_category_id_index').on(table.categoryId),
]);

export const barcodeAliases = sqliteTable('barcode_aliases', {
  alias: text('alias').primaryKey(),
  productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'restrict' }),
});

export const adminSessions = sqliteTable('admin_sessions', {
  tokenHash: text('token_hash').primaryKey(),
  csrfToken: text('csrf_token').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actorSessionHash: text('actor_session_hash').notNull(),
  action: text('action').notNull(),
  productId: integer('product_id').references(() => products.id, { onDelete: 'restrict' }),
  details: text('details').notNull(),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});

export const catalogMetadata = sqliteTable('catalog_metadata', {
  id: integer('id').primaryKey(),
  catalogVersion: integer('catalog_version').notNull(),
});

export const importRuns = sqliteTable('import_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  actorSessionHash: text('actor_session_hash').notNull(),
  contentHash: text('content_hash').notNull(),
  baseCatalogVersion: integer('base_catalog_version').notNull(),
  catalogVersion: integer('catalog_version').notNull(),
  rowCount: integer('row_count').notNull(),
  createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
});
