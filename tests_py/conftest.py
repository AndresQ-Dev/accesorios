from __future__ import annotations

import io
import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from alembic.config import Config
from flask import Flask
from flask.testing import FlaskClient
from openpyxl import Workbook

from alembic import command
from app import create_app
from app.auth import create_password_hash
from app.db import dispose_engines

ORIGIN = "https://local.test"
XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def migrate(path: Path) -> None:
    config = Config(Path(__file__).parents[1] / "alembic.ini")
    config.set_main_option("script_location", str(Path(__file__).parents[1] / "alembic"))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{path}")
    command.upgrade(config, "head")


@pytest.fixture(scope="session")
def passwords() -> dict[str, str]:
    return {
        "app": "test-app-password",
        "admin": "different-test-admin-password",
        "app_hash": create_password_hash("test-app-password"),
        "admin_hash": create_password_hash("different-test-admin-password"),
    }


@pytest.fixture
def database_path(tmp_path: Path) -> Iterator[Path]:
    path = tmp_path / "catalog.sqlite"
    migrate(path)
    yield path
    dispose_engines()


@pytest.fixture
def app(database_path: Path, tmp_path: Path, passwords: dict[str, str]) -> Flask:
    return create_app({
        "TESTING": True,
        "DATABASE_PATH": database_path,
        "BACKUP_DIRECTORY": tmp_path / "backups",
        "APP_PASSWORD_HASH": passwords["app_hash"],
        "ADMIN_PASSWORD_HASH": passwords["admin_hash"],
        "TRUSTED_ORIGIN": ORIGIN,
        "COOKIE_SECURE": True,
        "LOGIN_MAX_ATTEMPTS": 3,
    })


@pytest.fixture
def client(app: Flask) -> FlaskClient:
    return app.test_client()


@pytest.fixture
def db(database_path: Path) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    yield connection
    connection.close()


@pytest.fixture
def login_app(client: FlaskClient, passwords: dict[str, str]) -> Callable[[], str]:
    def login() -> str:
        response = client.post(
            "/api/v1/login",
            json={"password": passwords["app"]},
            headers={"Origin": ORIGIN},
            base_url=ORIGIN,
        )
        assert response.status_code == 200
        return response.get_json()["csrfToken"]
    return login


@pytest.fixture
def login_admin(
    client: FlaskClient,
    login_app: Callable[[], str],
    passwords: dict[str, str],
) -> Callable[[], str]:
    def login() -> str:
        if client.get_cookie("app_session", domain="local.test") is None:
            login_app()
        response = client.post(
            "/api/v1/admin/login",
            json={"password": passwords["admin"]},
            headers={"Origin": ORIGIN},
            base_url=ORIGIN,
        )
        assert response.status_code == 200
        return response.get_json()["csrfToken"]
    return login


@pytest.fixture
def workbook_bytes() -> Callable[[list[list[object]], list[str] | None], bytes]:
    headers = ["Código", "C.Barras", "Articulo", "Stock fisico", "Precio"]

    def build(rows: list[list[object]], first_row: list[str] | None = None) -> bytes:
        book = Workbook()
        sheet = book.active
        sheet.title = "Products"
        sheet.append(first_row or headers)
        for row in rows:
            sheet.append(row)
        stream = io.BytesIO()
        book.save(stream)
        book.close()
        return stream.getvalue()
    return build
