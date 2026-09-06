from __future__ import annotations

import sqlite3
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, event, pool

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = None


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    @event.listens_for(connectable, "connect")
    def configure_sqlite(dbapi_connection, _record) -> None:  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA busy_timeout = 5000")
            try:
                cursor.execute("PRAGMA journal_mode = DELETE")
                mode_row = cursor.fetchone()
            except sqlite3.DatabaseError as error:
                raise RuntimeError("SQLite journal mode transition to DELETE failed.") from error
            actual_mode = str(mode_row[0]).lower() if mode_row else "missing"
            if actual_mode != "delete":
                raise RuntimeError(
                    f"SQLite journal mode transition to DELETE failed; database reported {actual_mode!r}."
                )
            cursor.execute("PRAGMA foreign_keys = ON")
        finally:
            cursor.close()

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
