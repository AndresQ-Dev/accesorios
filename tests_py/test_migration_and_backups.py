from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

from flask import Flask

from app.backups import create_backup, enforce_retention, verify_backup
from app.db import engine_for, validate_schema
from tests_py.conftest import migrate

LEGACY_DRIZZLE_SCHEMA = """
CREATE TABLE categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    name TEXT NOT NULL, name_key TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deactivated_at TEXT
);
CREATE UNIQUE INDEX categories_name_key_unique ON categories (name_key);
CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    code TEXT NOT NULL, code_key TEXT NOT NULL, barcode TEXT, brand TEXT, brand_key TEXT,
    article TEXT NOT NULL, article_key TEXT NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
    stock INTEGER, price_ars INTEGER NOT NULL CHECK (price_ars >= 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX products_code_key_unique ON products (code_key);
CREATE UNIQUE INDEX products_barcode_unique ON products (barcode);
CREATE INDEX products_article_key_index ON products (article_key);
CREATE INDEX products_brand_key_index ON products (brand_key);
CREATE INDEX products_category_id_index ON products (category_id);
CREATE TABLE barcode_aliases (
    alias TEXT PRIMARY KEY NOT NULL,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT
);
CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY NOT NULL,
    csrf_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX admin_sessions_expiry_index ON admin_sessions (expires_at);
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    actor_session_hash TEXT NOT NULL,
    action TEXT NOT NULL,
    product_id INTEGER REFERENCES products(id) ON DELETE RESTRICT,
    details TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX audit_log_product_index ON audit_log (product_id);
CREATE TABLE catalog_metadata (
    id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    catalog_version INTEGER NOT NULL CHECK (catalog_version >= 0)
);
INSERT INTO catalog_metadata (id, catalog_version)
VALUES (1, (SELECT COALESCE(MAX(revision), 0) FROM products));
CREATE TABLE import_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
    actor_session_hash TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    base_catalog_version INTEGER NOT NULL,
    catalog_version INTEGER NOT NULL,
    row_count INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def test_alembic_adopts_drizzle_schema_without_changing_ids_or_timestamps(tmp_path: Path) -> None:
    path = tmp_path / "legacy.sqlite"
    connection = sqlite3.connect(path)
    connection.executescript(LEGACY_DRIZZLE_SCHEMA)
    connection.execute(
        """INSERT INTO products
        (id, code, code_key, barcode, article, article_key, price_ars, created_at, updated_at)
        VALUES (42, 'ITF', 'itf', '4440000015833', 'Item', 'item', 10, '2020-old', '2020-old')"""
    )
    connection.commit()
    connection.close()
    migrate(path)
    adopted = sqlite3.connect(path)
    product = adopted.execute("SELECT id, created_at, updated_at FROM products").fetchone()
    assert product == (42, "2020-old", "2020-old")
    alias = adopted.execute("SELECT alias, product_id FROM barcode_aliases").fetchone()
    assert alias == ("04440000015833", 42)
    tables = {row[0] for row in adopted.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert {"app_sessions", "login_attempts", "import_previews", "alembic_version"} <= tables
    adopted.close()
    assert validate_schema(engine_for(path)) == []


def test_fresh_schema_enables_foreign_keys_wal_and_validation(database_path: Path) -> None:
    engine = engine_for(database_path)
    with engine.connect() as connection:
        assert connection.exec_driver_sql("PRAGMA foreign_keys").scalar_one() == 1
        assert connection.exec_driver_sql("PRAGMA journal_mode").scalar_one() == "wal"
        assert connection.exec_driver_sql("PRAGMA busy_timeout").scalar_one() == 5000
    assert validate_schema(engine) == []


def test_migration_rebuilds_legacy_not_null_product_prices(tmp_path: Path) -> None:
    path = tmp_path / "legacy-not-null.sqlite"
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
            name TEXT NOT NULL, name_key TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, deactivated_at TEXT
        );
        CREATE TABLE products (
            id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
            code TEXT NOT NULL, code_key TEXT NOT NULL, barcode TEXT, brand TEXT, brand_key TEXT,
            article TEXT NOT NULL, article_key TEXT NOT NULL,
            category_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
            stock INTEGER, price_ars INTEGER NOT NULL CHECK (price_ars >= 0),
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX products_code_key_unique ON products (code_key);
        CREATE UNIQUE INDEX products_barcode_unique ON products (barcode);
        CREATE INDEX products_article_key_index ON products (article_key);
        CREATE INDEX products_brand_key_index ON products (brand_key);
        CREATE INDEX products_category_id_index ON products (category_id);
        INSERT INTO products
        (code, code_key, barcode, article, article_key, price_ars, created_at, updated_at)
        VALUES ('LEGACY', 'legacy', NULL, 'Legacy', 'legacy', 10, 'old', 'old');
        """
    )
    connection.commit()
    connection.close()

    migrate(path)

    migrated = sqlite3.connect(path)
    price_column = next(
        row for row in migrated.execute("PRAGMA table_info(products)") if row[1] == "price_ars"
    )
    assert price_column[3] == 0
    migrated.execute(
        """INSERT INTO products (code, code_key, article, article_key, price_ars)
        VALUES ('NULL', 'null', 'Null price', 'null price', NULL)"""
    )
    try:
        migrated.execute(
            """INSERT INTO products (code, code_key, article, article_key, price_ars)
            VALUES ('NEG', 'neg', 'Negative price', 'negative price', -1)"""
        )
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("negative prices must remain rejected")
    migrated.close()
    assert validate_schema(engine_for(path)) == []


def test_backup_checksum_and_retention(
    app: Flask,
    database_path: Path,
    tmp_path: Path,
) -> None:
    with app.app_context():
        paths = [create_backup() for _ in range(4)]
        assert all(path.exists() and verify_backup(path) for path in paths)
        assert all(path.with_suffix(path.suffix + ".sha256").exists() for path in paths)
        app.config["BACKUP_RETENTION_COUNT"] = 2
        latest = create_backup()
        remaining = list((tmp_path / "backups").glob("catalog-import-*.sqlite"))
        assert len(remaining) == 2
        assert latest in remaining
        assert verify_backup(latest)

        latest.write_bytes(latest.read_bytes() + b"tampered")
        assert verify_backup(latest) is False


def test_retention_removes_orphan_sidecars(tmp_path: Path) -> None:
    directory = tmp_path / "backups"
    directory.mkdir()
    orphan = directory / "catalog-import-orphan.sqlite.sha256"
    orphan.write_text(hashlib.sha256(b"x").hexdigest(), encoding="ascii")
    enforce_retention(directory, max_count=1, max_bytes=1024)
    assert not orphan.exists()
