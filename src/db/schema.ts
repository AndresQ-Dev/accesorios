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
