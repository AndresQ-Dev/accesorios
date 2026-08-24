"""Allow catalog products without prices.

Revision ID: 0003_nullable_product_prices
Revises: 0002_python_runtime
"""

from alembic import op

revision = "0003_nullable_product_prices"
down_revision = "0002_python_runtime"
branch_labels = None
depends_on = None


def upgrade() -> None:
    _rebuild_products(price_definition="price_ars INTEGER CHECK (price_ars >= 0)")


def downgrade() -> None:
    op.execute("UPDATE products SET price_ars = 0 WHERE price_ars IS NULL")
    _rebuild_products(price_definition="price_ars INTEGER NOT NULL CHECK (price_ars >= 0)")


def _rebuild_products(*, price_definition: str) -> None:
    statements = [
        "PRAGMA foreign_keys=OFF",
        "DROP TABLE IF EXISTS products_new",
        f"""CREATE TABLE products_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
            code TEXT NOT NULL, code_key TEXT NOT NULL, barcode TEXT, brand TEXT, brand_key TEXT,
            article TEXT NOT NULL, article_key TEXT NOT NULL,
            category_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
            stock INTEGER, {price_definition},
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""",
        """INSERT INTO products_new
            (id, code, code_key, barcode, brand, brand_key, article, article_key,
             category_id, stock, price_ars, revision, created_at, updated_at)
            SELECT id, code, code_key, barcode, brand, brand_key, article, article_key,
                   category_id, stock, price_ars, revision, created_at, updated_at
            FROM products""",
        "DROP TABLE products",
        "ALTER TABLE products_new RENAME TO products",
        "CREATE UNIQUE INDEX products_code_key_unique ON products (code_key)",
        "CREATE UNIQUE INDEX products_barcode_unique ON products (barcode)",
        "CREATE INDEX products_article_key_index ON products (article_key)",
        "CREATE INDEX products_brand_key_index ON products (brand_key)",
        "CREATE INDEX products_category_id_index ON products (category_id)",
        "PRAGMA foreign_keys=ON",
    ]
    for statement in statements:
        op.execute(statement)
    op.execute("PRAGMA foreign_key_check")
