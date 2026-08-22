import type Database from 'better-sqlite3';

const UNDEFINED_LABEL = 'Sin definir';

type ProductRow = {
  id: number;
  code: string;
  codeKey: string;
  barcode: string | null;
  brand: string | null;
  article: string;
  category: string | null;
  priceArs: number;
  revision: number;
  updatedAt: string;
};

export type CatalogSearchResult = {
  id: number;
  code: string;
  brand: string;
  article: string;
  category: string;
  priceArs: number;
};

export type CatalogSearchResponse = {
  results: CatalogSearchResult[];
  catalogVersion: number;
  freshness: string | null;
};

export function normalizeSearchText(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es-AR');
}

function rankProduct(product: ProductRow, query: string) {
  if (product.barcode !== null && normalizeSearchText(product.barcode) === query) return 0;
  if (product.codeKey === query) return 1;
  if (product.codeKey.startsWith(query)) return 2;

  const descriptiveText = normalizeSearchText([product.brand, product.article, product.category]
    .filter((value): value is string => value !== null)
    .join(' '));
  const tokens = query.split(' ');
  const words = descriptiveText.split(' ');

  if (tokens.every((token) => words.some((word) => word.startsWith(token)))) return 3;
  if (tokens.every((token) => descriptiveText.includes(token))) return 4;
  return null;
}

function compareProducts(left: ProductRow, right: ProductRow) {
  return (left.brand ?? UNDEFINED_LABEL).localeCompare(right.brand ?? UNDEFINED_LABEL, 'es')
    || left.article.localeCompare(right.article, 'es')
    || left.code.localeCompare(right.code, 'es');
}

export function searchCatalog(sqlite: Database.Database, rawQuery: string): CatalogSearchResponse {
  const query = normalizeSearchText(rawQuery);
  const products = sqlite.prepare(`
    SELECT products.id, products.code, products.code_key AS codeKey, products.barcode,
      products.brand, products.article, categories.name AS category, products.price_ars AS priceArs,
      products.revision, products.updated_at AS updatedAt
    FROM products
    LEFT JOIN categories ON categories.id = products.category_id
  `).all() as ProductRow[];
  const rankedProducts = products
    .map((product) => ({ product, rank: rankProduct(product, query) }))
    .filter((entry): entry is { product: ProductRow; rank: number } => entry.rank !== null)
    .sort((left, right) => left.rank - right.rank || compareProducts(left.product, right.product));
  const metadata = sqlite.prepare(`
    SELECT COALESCE(MAX(revision), 0) AS catalogVersion, MAX(updated_at) AS freshness
    FROM products
  `).get() as { catalogVersion: number; freshness: string | null };

  return {
    results: rankedProducts.map(({ product }) => ({
      id: product.id,
      code: product.code,
      brand: product.brand ?? UNDEFINED_LABEL,
      article: product.article,
      category: product.category ?? UNDEFINED_LABEL,
      priceArs: product.priceArs,
    })),
    catalogVersion: metadata.catalogVersion,
    freshness: metadata.freshness,
  };
}
