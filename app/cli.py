from __future__ import annotations

from pathlib import Path

import click
from alembic.config import Config
from flask import Flask, current_app

from alembic import command
from app.auth import create_password_hash
from app.backups import create_backup, verify_backup
from app.db import validate_schema


def _alembic_config() -> Config:
    project_root = Path(current_app.root_path).parent
    config = Config(project_root / "alembic.ini")
    config.set_main_option("script_location", str(project_root / "alembic"))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{current_app.config['DATABASE_PATH']}")
    return config


def register_cli(app: Flask) -> None:
    @app.cli.command("db-upgrade")
    def db_upgrade() -> None:
        """Adopt an existing Drizzle database and apply additive migrations."""
        command.upgrade(_alembic_config(), "head")
        click.echo("Database migrations applied.")

    @app.cli.command("db-validate")
    def db_validate() -> None:
        """Validate the required schema and verified alias without mutation."""
        problems = validate_schema()
        if problems:
            raise click.ClickException("; ".join(problems))
        click.echo("Database schema is valid.")

    @app.cli.command("backup-create")
    def backup_create() -> None:
        """Create and verify a bounded-retention SQLite backup."""
        path = create_backup()
        if not verify_backup(path):
            raise click.ClickException(f"Backup checksum failed: {path}")
        click.echo(f"Backup created and verified: {path}")

    @app.cli.command("password-hash")
    @click.argument("password")
    def password_hash(password: str) -> None:
        """Print a PBKDF2 hash for APP_PASSWORD_HASH or ADMIN_PASSWORD_HASH."""
        click.echo(create_password_hash(password))
