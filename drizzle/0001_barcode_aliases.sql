CREATE TABLE `barcode_aliases` (
  `alias` TEXT PRIMARY KEY NOT NULL,
  `product_id` INTEGER NOT NULL REFERENCES `products`(`id`) ON DELETE RESTRICT
);
