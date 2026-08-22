CREATE TABLE `categories` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` TEXT NOT NULL,
  `name_key` TEXT NOT NULL,
  `active` INTEGER NOT NULL DEFAULT 1 CHECK (`active` IN (0, 1)),
  `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `deactivated_at` TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_name_key_unique` ON `categories` (`name_key`);
--> statement-breakpoint
CREATE TABLE `products` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  `code` TEXT NOT NULL,
  `code_key` TEXT NOT NULL,
  `barcode` TEXT,
  `brand` TEXT,
  `brand_key` TEXT,
  `article` TEXT NOT NULL,
  `article_key` TEXT NOT NULL,
  `category_id` INTEGER REFERENCES `categories`(`id`) ON DELETE RESTRICT,
  `stock` INTEGER,
  `price_ars` INTEGER NOT NULL CHECK (`price_ars` >= 0),
  `revision` INTEGER NOT NULL DEFAULT 1 CHECK (`revision` >= 1),
  `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_code_key_unique` ON `products` (`code_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_barcode_unique` ON `products` (`barcode`);
--> statement-breakpoint
CREATE INDEX `products_article_key_index` ON `products` (`article_key`);
--> statement-breakpoint
CREATE INDEX `products_brand_key_index` ON `products` (`brand_key`);
--> statement-breakpoint
CREATE INDEX `products_category_id_index` ON `products` (`category_id`);
