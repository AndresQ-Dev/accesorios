import type Database from 'better-sqlite3';

export class BarcodeAliasCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BarcodeAliasCollisionError';
  }
}

export function registerBarcodeAlias(
  sqlite: Database.Database,
  alias: string,
  canonicalBarcode: string,
) {
  const register = sqlite.transaction(() => {
    const canonicalProduct = sqlite.prepare('SELECT id FROM products WHERE barcode = ?').get(canonicalBarcode) as { id: number } | undefined;
    if (canonicalProduct === undefined) {
      throw new BarcodeAliasCollisionError(`Canonical barcode ${canonicalBarcode} does not exist.`);
    }

    const canonicalCollision = sqlite.prepare('SELECT id FROM products WHERE barcode = ?').get(alias);
    if (canonicalCollision !== undefined) {
      throw new BarcodeAliasCollisionError(`Alias ${alias} collides with a canonical barcode.`);
    }

    const aliasCollision = sqlite.prepare('SELECT product_id FROM barcode_aliases WHERE alias = ?').get(alias);
    if (aliasCollision !== undefined) {
      throw new BarcodeAliasCollisionError(`Alias ${alias} is already registered.`);
    }

    sqlite.prepare('INSERT INTO barcode_aliases (alias, product_id) VALUES (?, ?)').run(alias, canonicalProduct.id);
  });

  register();
}

export function resolveBarcodeProductId(sqlite: Database.Database, barcode: string) {
  const canonicalProduct = sqlite.prepare('SELECT id FROM products WHERE barcode = ?').get(barcode) as { id: number } | undefined;
  if (canonicalProduct !== undefined) return canonicalProduct.id;

  const aliasProduct = sqlite.prepare('SELECT product_id AS id FROM barcode_aliases WHERE alias = ?').get(barcode) as { id: number } | undefined;
  return aliasProduct?.id;
}
