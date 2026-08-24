from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from flask import current_app
from sqlalchemy import Connection, Engine, create_engine, event, inspect, text
from sqlalchemy.engine import URL

_engines: dict[Path, Engine] = {}


def engine_for(path: Path) -> Engine:
    resolved = path.resolve()
    if resolved not in _engines:
        resolved.parent.mkdir(parents=True, exist_ok=True)
        engine = create_engine(
            URL.create("sqlite+pysqlite", database=str(resolved)),
            future=True,
            pool_pre_ping=True,
        )

        @event.listens_for(engine, "connect")
        def configure_sqlite(dbapi_connection: Any, _record: Any) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys = ON")
            cursor.execute("PRAGMA journal_mode = WAL")
            cursor.execute("PRAGMA busy_timeout = 5000")
            cursor.close()

        _engines[resolved] = engine
    return _engines[resolved]


def get_engine() -> Engine:
    return engine_for(Path(current_app.config["DATABASE_PATH"]))


@contextmanager
def read_connection() -> Iterator[Connection]:
    with get_engine().connect() as connection:
        yield connection


@contextmanager
def write_connection() -> Iterator[Connection]:
    with get_engine().connect() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise


REQUIRED_SCHEMA: dict[str, set[str]] = {
    "categories": {"id", "name", "name_key", "active", "created_at", "updated_at", "deactivated_at"},
    "products": {
        "id", "code", "code_key", "barcode", "brand", "brand_key", "article", "article_key",
        "category_id", "stock", "price_ars", "revision", "created_at", "updated_at",
    },
    "barcode_aliases": {"alias", "product_id"},
    "admin_sessions": {"token_hash", "csrf_token", "expires_at", "created_at"},
    "app_sessions": {"token_hash", "csrf_token", "expires_at", "created_at"},
    "audit_log": {"id", "actor_session_hash", "action", "product_id", "details", "created_at"},
    "catalog_metadata": {"id", "catalog_version"},
    "import_runs": {
        "id", "actor_session_hash", "content_hash", "base_catalog_version", "catalog_version",
        "row_count", "created_at",
    },
    "import_previews": {
        "reference", "actor_session_hash", "content_hash", "base_catalog_version", "expires_at",
        "rows_json", "created_at",
    },
    "login_attempts": {"scope", "client_key", "attempted_at"},
}


def validate_schema(engine: Engine | None = None) -> list[str]:
    target = engine or get_engine()
    inspector = inspect(target)
    table_names = set(inspector.get_table_names())
    problems: list[str] = []
    for table, required_columns in REQUIRED_SCHEMA.items():
        if table not in table_names:
            problems.append(f"missing table: {table}")
            continue
        actual = {column["name"] for column in inspector.get_columns(table)}
        for column in sorted(required_columns - actual):
            problems.append(f"missing column: {table}.{column}")
        if table == "products":
            price_column = next(
                (column for column in inspector.get_columns(table) if column["name"] == "price_ars"),
                None,
            )
            if price_column is not None and not price_column["nullable"]:
                problems.append("products.price_ars must allow NULL")
    with target.connect() as connection:
        if connection.execute(text("PRAGMA foreign_keys")).scalar_one() != 1:
            problems.append("foreign_keys pragma is disabled")
        alias = connection.execute(
            text("SELECT product_id FROM barcode_aliases WHERE alias = '04440000015833'")
        ).scalar_one_or_none() if "barcode_aliases" in table_names else None
        alias_barcode = connection.execute(
            text(
                "SELECT products.barcode FROM barcode_aliases "
                "JOIN products ON products.id = barcode_aliases.product_id "
                "WHERE barcode_aliases.alias = '04440000015833'"
            )
        ).scalar_one_or_none() if "barcode_aliases" in table_names and "products" in table_names else None
        canonical = connection.execute(
            text("SELECT id FROM products WHERE barcode = '4440000015833'")
        ).scalar_one_or_none() if "products" in table_names else None
        if canonical is not None and alias != canonical:
            problems.append("verified ITF alias is missing or points to another product")
        if alias is not None and alias_barcode != "4440000015833":
            problems.append("verified ITF alias points to a non-canonical barcode")
    return problems


def dispose_engines() -> None:
    for engine in _engines.values():
        engine.dispose()
    _engines.clear()
