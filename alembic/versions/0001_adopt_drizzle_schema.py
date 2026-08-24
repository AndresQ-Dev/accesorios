"""Adopt the existing Drizzle catalog schema without recreating data.

Revision ID: 0001_adopt_drizzle
Revises:
"""

from alembic import op

revision = "0001_adopt_drizzle"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    statements = [
        """CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
            name TEXT NOT NULL, name_key TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deactivated_at TEXT
        )""",
        "CREATE UNIQUE INDEX IF NOT EXISTS categories_name_key_unique ON categories (name_key)",
        """CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
            code TEXT NOT NULL, code_key TEXT NOT NULL, barcode TEXT, brand TEXT, brand_key TEXT,
            article TEXT NOT NULL, article_key TEXT NOT NULL,
            category_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
            stock INTEGER, price_ars INTEGER CHECK (price_ars >= 0),
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""",
        "CREATE UNIQUE INDEX IF NOT EXISTS products_code_key_unique ON products (code_key)",
        "CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_unique ON products (barcode)",
        "CREATE INDEX IF NOT EXISTS products_article_key_index ON products (article_key)",
        "CREATE INDEX IF NOT EXISTS products_brand_key_index ON products (brand_key)",
        "CREATE INDEX IF NOT EXISTS products_category_id_index ON products (category_id)",
        """CREATE TABLE IF NOT EXISTS barcode_aliases (
            alias TEXT PRIMARY KEY NOT NULL,
            product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT
        )""",
        """CREATE TABLE IF NOT EXISTS admin_sessions (
            token_hash TEXT PRIMARY KEY NOT NULL, csrf_token TEXT NOT NULL,
            expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""",
        "CREATE INDEX IF NOT EXISTS admin_sessions_expiry_index ON admin_sessions (expires_at)",
        """CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
            actor_session_hash TEXT NOT NULL, action TEXT NOT NULL,
            product_id INTEGER REFERENCES products(id) ON DELETE RESTRICT,
            details TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""",
        "CREATE INDEX IF NOT EXISTS audit_log_product_index ON audit_log (product_id)",
        """CREATE TABLE IF NOT EXISTS catalog_metadata (
            id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
            catalog_version INTEGER NOT NULL CHECK (catalog_version >= 0)
        )""",
        """INSERT OR IGNORE INTO catalog_metadata (id, catalog_version)
            SELECT 1, COALESCE(MAX(revision), 0) FROM products
        """,
        """CREATE TABLE IF NOT EXISTS import_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
            actor_session_hash TEXT NOT NULL, content_hash TEXT NOT NULL,
            base_catalog_version INTEGER NOT NULL, catalog_version INTEGER NOT NULL,
            row_count INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""",
        """INSERT INTO barcode_aliases (alias, product_id)
            SELECT '04440000015833', products.id FROM products
            WHERE products.barcode = '4440000015833'
              AND NOT EXISTS (SELECT 1 FROM products WHERE barcode = '04440000015833')
              AND NOT EXISTS (SELECT 1 FROM barcode_aliases WHERE alias = '04440000015833')""",
    ]
    for statement in statements:
        op.execute(statement)


def downgrade() -> None:
    # The baseline adopts authoritative catalog data and is intentionally irreversible.
    pass
