from __future__ import annotations

import io
import sqlite3
import zipfile
from collections.abc import Callable
from pathlib import Path

from flask import Flask
from flask.testing import FlaskClient

from app import create_app
from app.backups import verify_backup
from tests_py.conftest import ORIGIN, XLSX_TYPE


def headers(csrf: str) -> dict[str, str]:
    return {"Origin": ORIGIN, "X-CSRF-Token": csrf, "Content-Type": XLSX_TYPE}


def preview(client: FlaskClient, csrf: str, body: bytes):
    return client.post(
        "/api/v1/admin/import/preview", data=body, headers=headers(csrf), base_url=ORIGIN,
    )


def confirm(client: FlaskClient, csrf: str, token: dict):
    return client.post(
        "/api/v1/admin/import/confirm", json={
            "previewReference": token["previewReference"],
            "contentHash": token["contentHash"],
            "baseCatalogVersion": token["baseCatalogVersion"],
        },
        headers={"Origin": ORIGIN, "X-CSRF-Token": csrf}, base_url=ORIGIN,
    )


def seed_existing(db: sqlite3.Connection) -> None:
    db.execute(
        """INSERT INTO products
        (code, code_key, barcode, brand, brand_key, article, article_key, stock, price_ars)
        VALUES ('EXISTING', 'existing', '111', 'Maintained', 'maintained', 'Old', 'old', 1, 100)"""
    )
    db.execute("UPDATE catalog_metadata SET catalog_version = 1 WHERE id = 1")
    db.commit()


def test_preview_and_confirmation_count_only_real_product_changes(
    client: FlaskClient,
    db: sqlite3.Connection,
    login_admin: Callable[[], str],
    workbook_bytes: Callable[[list[list[object]], list[str] | None], bytes],
) -> None:
    db.executemany(
        """INSERT INTO products
        (code, code_key, barcode, article, article_key, stock, price_ars, revision, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [
            ("A1", "a1", "111", "Casco sin cambios", "casco sin cambios", 2, 100, 4, "2026-01-01 10:00:00"),
            ("B2", "b2", "222", "Casco con cambio", "casco con cambio", 3, 200, 5, "2026-01-01 10:00:00"),
        ],
    )
    db.execute("UPDATE catalog_metadata SET catalog_version = 5 WHERE id = 1")
    db.commit()
    csrf = login_admin()

    response = preview(client, csrf, workbook_bytes([
        ["A1", "111", "Casco sin cambios", 2, 100],
        ["B2", "222", "Casco con cambio", 3, 250],
    ]))

    assert response.status_code == 200
    token = response.get_json()
    assert token["diff"] == {"creates": 0, "updates": 1}
    confirmed = confirm(client, csrf, token)
    assert confirmed.status_code == 200
    assert confirmed.get_json() == {"catalogVersion": 6, "creates": 0, "updates": 1}
    rows = db.execute(
        "SELECT code_key, price_ars, revision, updated_at FROM products ORDER BY code_key"
    ).fetchall()
    assert tuple(rows[0]) == ("a1", 100, 4, "2026-01-01 10:00:00")
    assert rows[1]["code_key"] == "b2"
    assert rows[1]["price_ars"] == 250
    assert rows[1]["revision"] == 6
    assert rows[1]["updated_at"] != "2026-01-01 10:00:00"


def test_preview_is_persistent_session_bound_and_confirmation_is_atomic(
    app: Flask,
    client: FlaskClient,
    db: sqlite3.Connection,
    login_admin: Callable[[], str],
    workbook_bytes: Callable[[list[list[object]], list[str] | None], bytes],
    database_path: Path,
    tmp_path: Path,
) -> None:
    seed_existing(db)
    csrf = login_admin()
    response = preview(client, csrf, workbook_bytes([
        [" existing ", "111", "Updated item", 3, 125],
        ["NEW", "222", "New item", 4, 250],
    ]))
    assert response.status_code == 200
    token = response.get_json()
    assert token["diff"] == {"creates": 1, "updates": 1}
    assert db.execute("SELECT COUNT(*) FROM import_previews").fetchone()[0] == 1
    assert db.execute("SELECT price_ars FROM products WHERE code_key = 'existing'").fetchone()[0] == 100

    reloaded = create_app({
        "TESTING": True, "DATABASE_PATH": database_path, "BACKUP_DIRECTORY": tmp_path / "backups",
        "APP_PASSWORD_HASH": app.config["APP_PASSWORD_HASH"],
        "ADMIN_PASSWORD_HASH": app.config["ADMIN_PASSWORD_HASH"],
        "TRUSTED_ORIGIN": ORIGIN, "COOKIE_SECURE": True,
    })
    client2 = reloaded.test_client()
    for name in ("app_session", "admin_session"):
        cookie = client.get_cookie(name, domain="local.test")
        client2.set_cookie(name, cookie.value, domain="local.test", secure=True)
    confirmed = confirm(client2, csrf, token)
    assert confirmed.status_code == 200
    assert confirmed.get_json() == {"catalogVersion": 2, "creates": 1, "updates": 1}
    rows = db.execute(
        "SELECT code, brand, stock, price_ars, revision FROM products ORDER BY code_key"
    ).fetchall()
    assert [tuple(row) for row in rows] == [
        ("existing", "Maintained", 3, 125, 2),
        ("NEW", None, 4, 250, 1),
    ]
    assert db.execute("SELECT COUNT(*) FROM import_previews").fetchone()[0] == 0
    assert db.execute("SELECT COUNT(*) FROM import_runs").fetchone()[0] == 1
    backups = list((tmp_path / "backups").glob("*.sqlite"))
    assert len(backups) == 1
    assert verify_backup(backups[0])


def test_blank_prices_preview_confirm_and_search_as_null(
    client: FlaskClient,
    db: sqlite3.Connection,
    login_admin: Callable[[], str],
    workbook_bytes: Callable[[list[list[object]], list[str] | None], bytes],
) -> None:
    csrf = login_admin()
    response = preview(client, csrf, workbook_bytes(
        [["NO-PRICE", "333", "Campera sin precio", 5, None], [None, None, None, None, None]],
        ["Código", "C.Barras", "Articulo", "Stock físico", "Precio"],
    ))

    assert response.status_code == 200
    token = response.get_json()
    assert token["diff"] == {"creates": 1, "updates": 0}
    assert token["rows"][0]["priceArs"] is None
    assert confirm(client, csrf, token).status_code == 200
    assert db.execute("SELECT price_ars FROM products WHERE code_key = 'no-price'").fetchone()[0] is None

    search = client.get("/api/v1/search?q=NO-PRICE", base_url=ORIGIN)
    assert search.status_code == 200
    assert search.get_json()["results"][0]["priceArs"] is None


def test_preview_is_bound_to_exact_admin_session(
    client: FlaskClient,
    login_admin: Callable[[], str],
    passwords: dict[str, str],
    workbook_bytes: Callable[[list[list[object]], list[str] | None], bytes],
) -> None:
    csrf = login_admin()
    token = preview(client, csrf, workbook_bytes([["A", "1", "Item", 1, 1]])).get_json()
    second = client.application.test_client()
    second.post(
        "/api/v1/login", json={"password": passwords["app"]}, headers={"Origin": ORIGIN}, base_url=ORIGIN,
    )
    admin = second.post(
        "/api/v1/admin/login", json={"password": passwords["admin"]},
        headers={"Origin": ORIGIN}, base_url=ORIGIN,
    )
    other_csrf = admin.get_json()["csrfToken"]
    response = confirm(second, other_csrf, token)
    assert response.status_code == 409
    assert response.get_json()["error"]["code"] == "PREVIEW_NOT_FOUND"


def test_xlsx_limits_headers_formulas_scientific_values_macros_and_duplicates(
    client: FlaskClient,
    login_admin: Callable[[], str],
    workbook_bytes: Callable[[list[list[object]], list[str] | None], bytes],
) -> None:
    csrf = login_admin()
    cases = [
        workbook_bytes(
            [["A", "1", "Item", 1, 1]],
            ["Code", "C.Barras", "Articulo", "Stock fisico", "Precio"],
        ),
        workbook_bytes([[" A ", "1", "Item", 1, 1], ["a", "2", "Other", 1, 2]]),
        workbook_bytes([["A", "1", "Item", 1, 1], ["B", "1", "Other", 1, 2]]),
        workbook_bytes([["A", "1E+12", "Item", 1, 1]]),
        workbook_bytes([["A", "1", "Item", -1, 1]]),
        workbook_bytes([["A", "1", "Item", 1, -1]]),
        workbook_bytes([["A", "1", "Item", 1, "not-price"]]),
        workbook_bytes([["A", "1", "x" * 513, 1, 1]]),
        workbook_bytes([["A", "1", "Item", 1, "=1+1"]]),
    ]
    macro = io.BytesIO(workbook_bytes([["A", "1", "Item", 1, 1]]))
    with zipfile.ZipFile(macro, "a") as archive:
        archive.writestr("xl/vbaProject.bin", b"macro")
    cases.append(macro.getvalue())
    for body in cases:
        response = preview(client, csrf, body)
        assert response.status_code == 422
        assert response.get_json()["error"]["code"] == "INVALID_XLSX"
    assert preview(client, csrf, b"x" * (2 * 1024 * 1024 + 1)).status_code == 413


def test_confirmation_rejects_mismatch_expiry_version_and_barcode_collisions_without_mutation(
    client: FlaskClient,
    db: sqlite3.Connection,
    login_admin: Callable[[], str],
    workbook_bytes: Callable[[list[list[object]], list[str] | None], bytes],
) -> None:
    seed_existing(db)
    csrf = login_admin()
    token = preview(client, csrf, workbook_bytes([["NEW", "222", "New", 1, 2]])).get_json()
    wrong = dict(token)
    wrong["contentHash"] = "0" * 64
    assert confirm(client, csrf, wrong).status_code == 409
    assert db.execute("SELECT COUNT(*) FROM products").fetchone()[0] == 1
    db.execute("UPDATE import_previews SET expires_at = '2000-01-01T00:00:00.000Z'")
    db.commit()
    expired = confirm(client, csrf, token)
    assert expired.status_code == 409
    assert expired.get_json()["error"]["code"] == "PREVIEW_EXPIRED"

    token = preview(client, csrf, workbook_bytes([["NEW", "222", "New", 1, 2]])).get_json()
    db.execute("UPDATE products SET revision = revision + 1 WHERE code_key = 'existing'")
    db.commit()
    assert confirm(client, csrf, token).status_code == 409

    db.execute("UPDATE products SET revision = 1 WHERE code_key = 'existing'")
    db.execute("INSERT INTO barcode_aliases (alias, product_id) VALUES ('alias-111', 1)")
    db.commit()
    token = preview(client, csrf, workbook_bytes([["NEW", "alias-111", "New", 1, 2]])).get_json()
    before = db.execute("SELECT COUNT(*) FROM products").fetchone()[0]
    collision = confirm(client, csrf, token)
    assert collision.status_code == 409
    assert collision.get_json()["error"]["code"] == "BARCODE_COLLISION"
    assert db.execute("SELECT COUNT(*) FROM products").fetchone()[0] == before


def test_verified_alias_and_trigger_failure_roll_back_the_entire_import(
    client: FlaskClient,
    db: sqlite3.Connection,
    login_admin: Callable[[], str],
    workbook_bytes: Callable[[list[list[object]], list[str] | None], bytes],
) -> None:
    csrf = login_admin()
    token = preview(client, csrf, workbook_bytes([
        ["ITF", "4440000015833", "ITF item", 1, 10],
    ])).get_json()
    assert confirm(client, csrf, token).status_code == 200
    alias = db.execute("SELECT alias, product_id FROM barcode_aliases").fetchone()
    assert alias[0] == "04440000015833"

    db.execute(
        """CREATE TRIGGER import_failure BEFORE INSERT ON products
        WHEN NEW.code_key = 'explode' BEGIN SELECT RAISE(ABORT, 'forced'); END"""
    )
    db.commit()
    token = preview(client, csrf, workbook_bytes([
        ["FIRST", "222", "First", 1, 1], ["EXPLODE", "333", "Explode", 1, 2],
    ])).get_json()
    before = db.execute("SELECT code FROM products ORDER BY id").fetchall()
    response = confirm(client, csrf, token)
    assert response.status_code == 500
    assert db.execute("SELECT code FROM products ORDER BY id").fetchall() == before
