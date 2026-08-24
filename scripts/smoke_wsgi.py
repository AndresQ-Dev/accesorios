from __future__ import annotations

import io
import json
import sqlite3
import tempfile
import threading
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

from alembic.config import Config
from openpyxl import Workbook
from werkzeug.serving import make_server

from alembic import command
from app import create_app
from app.auth import create_password_hash

PROJECT_ROOT = Path(__file__).resolve().parent.parent
XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def migrate(path: Path) -> None:
    config = Config(PROJECT_ROOT / "alembic.ini")
    config.set_main_option("script_location", str(PROJECT_ROOT / "alembic"))
    config.set_main_option("sqlalchemy.url", f"sqlite:///{path}")
    command.upgrade(config, "head")


def workbook() -> bytes:
    book = Workbook()
    sheet = book.active
    sheet.append(["Código", "C.Barras", "Articulo", "Stock fisico", "Precio"])
    sheet.append(["SMOKE", "4440000015833", "Smoke item updated", 2, 125])
    stream = io.BytesIO()
    book.save(stream)
    book.close()
    return stream.getvalue()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="precios-wsgi-smoke-") as directory:
        root = Path(directory)
        database = root / "catalog.sqlite"
        migrate(database)
        with sqlite3.connect(database) as connection:
            connection.execute(
                """INSERT INTO products
                (code, code_key, barcode, article, article_key, price_ars)
                VALUES ('SMOKE', 'smoke', '111', 'Smoke item', 'smoke item', 100)"""
            )
            connection.execute("UPDATE catalog_metadata SET catalog_version = 1 WHERE id = 1")
        app_password = "wsgi-smoke-app"
        admin_password = "wsgi-smoke-admin"
        app = create_app({
            "DATABASE_PATH": database,
            "BACKUP_DIRECTORY": root / "backups",
            "APP_PASSWORD_HASH": create_password_hash(app_password),
            "ADMIN_PASSWORD_HASH": create_password_hash(admin_password),
            "COOKIE_SECURE": False,
        })
        server = make_server("127.0.0.1", 0, app)
        origin = f"http://127.0.0.1:{server.server_port}"
        app.config["TRUSTED_ORIGIN"] = origin
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

        def request(
            path: str,
            *,
            data: bytes | None = None,
            content_type: str | None = None,
            csrf: str | None = None,
        ):
            headers = {"Origin": origin}
            if content_type:
                headers["Content-Type"] = content_type
            if csrf:
                headers["X-CSRF-Token"] = csrf
            request_value = urllib.request.Request(origin + path, data=data, headers=headers)
            response = opener.open(request_value, timeout=10)
            return response, json.loads(response.read())

        try:
            _, app_login = request(
                "/api/v1/login", data=json.dumps({"password": app_password}).encode(),
                content_type="application/json",
            )
            response, search = request("/api/v1/search?q=SMOKE")
            assert response.status == 200 and search["results"][0]["priceArs"] == 100
            _, admin_login = request(
                "/api/v1/admin/login", data=json.dumps({"password": admin_password}).encode(),
                content_type="application/json",
            )
            _, pending = request(
                "/api/v1/admin/import/preview", data=workbook(), content_type=XLSX_TYPE,
                csrf=admin_login["csrfToken"],
            )
            response, result = request(
                "/api/v1/admin/import/confirm",
                data=json.dumps({
                    "previewReference": pending["previewReference"],
                    "contentHash": pending["contentHash"],
                    "baseCatalogVersion": pending["baseCatalogVersion"],
                }).encode(),
                content_type="application/json", csrf=admin_login["csrfToken"],
            )
            assert response.status == 200 and result == {"catalogVersion": 2, "creates": 0, "updates": 1}
            assert app_login["csrfToken"]
            assert len(list((root / "backups").glob("*.sqlite"))) == 1
            print("WSGI smoke passed: app login, search, admin login, XLSX preview, confirmation, backup")
        finally:
            server.shutdown()
            thread.join(timeout=5)


if __name__ == "__main__":
    main()
